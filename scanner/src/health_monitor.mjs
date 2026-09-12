import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, statfs } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const CFG = {
  pollMs: Math.max(15_000, Number(process.env.HEALTH_POLL_MS || 30_000)),
  reminderMs: Math.max(5 * 60_000, Number(process.env.HEALTH_REMINDER_MS || 30 * 60_000)),
  startupGraceMs: Math.max(15_000, Number(process.env.HEALTH_STARTUP_GRACE_MS || 90_000)),
  restartCooldownMs: Math.max(5 * 60_000, Number(process.env.HEALTH_RESTART_COOLDOWN_MS || 10 * 60_000)),
  restartAfterFailures: Math.max(2, Number(process.env.HEALTH_RESTART_AFTER_FAILURES || 2)),
  diskWarnPct: Number(process.env.HEALTH_DISK_WARN_PCT || 80),
  diskCriticalPct: Number(process.env.HEALTH_DISK_CRITICAL_PCT || 92),
  opportunityStaleMs: Math.max(60_000, Number(process.env.HEALTH_OPPORTUNITY_STALE_MS || 180_000)),
  dbPath: String(process.env.SQLITE_PATH || '/data/rh_monitor.db'),
  statePath: String(process.env.HEALTH_STATE_PATH || '/data/rh_health_monitor_state.json'),
  statusPath: String(process.env.HEALTH_STATUS_PATH || '/data/rh_health_status.json'),
  rpcUrl: String(process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com'),
  barkServer: String(process.env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, ''),
  barkKey: String(process.env.BARK_DEVICE_KEY || '').trim(),
  telegramToken: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
  publicBase: String(process.env.HEALTH_PUBLIC_BASE || 'https://rh.192-236-234-216.sslip.io:8443').replace(/\/+$/, ''),
};

const PUBLIC_ROUTES = [
  ['opportunity', '/sheet-opportunity-71d9b4c2e8f6.csv'],
  ['history', '/sheet-history-4f0d7c91a2b8.csv'],
  ['calibration', '/sheet-calibration-8e3a1f6b7c2d.csv'],
  ['thresholds', '/sheet-thresholds-5a3d9c7e1b4f.csv'],
  ['shadow', '/sheet-shadow-2c7e9a4d1f6b.csv'],
];
const PROCESS_CHECKS = [
  ['alertWorker', 'alert_worker.mjs'],
  ['historyWorker', 'history_worker.mjs'],
  ['opportunityWorker', 'opportunity_worker.mjs'],
  ['shadowWorker', 'shadow_threshold_pool.mjs'],
];
const startedAt = Date.now();
let stopping = false;

function text(v) { return v == null ? '' : String(v).trim(); }
function iso() { return new Date().toISOString(); }
function ageMs(v) {
  const t = new Date(v || '').getTime();
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity;
}
function shortError(err) { return text(err?.message || err).slice(0, 220); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function atomicJson(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}
async function loadState() {
  try { return JSON.parse(await readFile(CFG.statePath, 'utf8')); }
  catch { return { failures: {}, active: [], lastNotifyAt: null, lastRestartAt: null }; }
}

async function commandOk(command, args = []) {
  try {
    const { stdout = '' } = await execFileAsync(command, args, { timeout: 5000 });
    return { ok: true, output: text(stdout) };
  } catch (err) {
    return { ok: false, error: shortError(err), output: text(err?.stdout) };
  }
}
async function serviceActive(name) {
  const r = await commandOk('systemctl', ['is-active', name]);
  return { ok: r.ok && r.output === 'active', detail: r.output || r.error || 'inactive' };
}
async function processAlive(pattern) {
  const r = await commandOk('pgrep', ['-af', pattern]);
  return { ok: r.ok && Boolean(r.output), detail: r.ok ? 'running' : 'missing' };
}
async function fetchCheck(url, expectJson = false) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6500), headers: { 'user-agent': 'rh-health-monitor/1.0' } });
    let payload = null;
    if (expectJson) {
      try { payload = await res.json(); } catch {}
    } else {
      try { await res.body?.cancel(); } catch {}
    }
    return { ok: res.ok && (!expectJson || payload?.ok !== false), status: res.status, payload };
  } catch (err) {
    return { ok: false, status: 0, error: shortError(err) };
  }
}
async function diskCheck() {
  try {
    const s = await statfs('/data');
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    const usedPct = total > 0 ? (1 - free / total) * 100 : 0;
    return { ok: usedPct < CFG.diskCriticalPct, usedPct, warn: usedPct >= CFG.diskWarnPct };
  } catch (err) { return { ok: false, usedPct: null, error: shortError(err) }; }
}
function dbCheck() {
  let db = null;
  try {
    db = new Database(CFG.dbPath, { readonly: true, fileMustExist: true, timeout: 4000 });
    const quick = text(db.pragma('quick_check', { simple: true })).toLowerCase();
    const table = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    let opportunityAt = null;
    let alertFailures24h = 0;
    if (table('opportunity_pool')) opportunityAt = db.prepare('SELECT MAX(updated_at) AS at FROM opportunity_pool').get()?.at || null;
    if (table('alert_events')) {
      alertFailures24h = Number(db.prepare(`
        SELECT COUNT(*) AS n FROM alert_events
        WHERE triggered_at >= datetime('now','-1 day')
          AND (bark_status='FAILED' OR telegram_status='FAILED')
      `).get()?.n || 0);
    }
    return {
      ok: quick === 'ok', quickCheck: quick || 'unknown', opportunityAt,
      opportunityAgeSec: Number.isFinite(ageMs(opportunityAt)) ? Math.round(ageMs(opportunityAt) / 1000) : null,
      alertFailures24h,
    };
  } catch (err) { return { ok: false, quickCheck: 'error', opportunityAt: null, error: shortError(err) }; }
  finally { try { db?.close(); } catch {} }
}
async function rpcCheck() {
  try {
    const res = await fetch(CFG.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'rh-health-monitor/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(6500),
    });
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    return { ok: res.ok && Boolean(parsed?.result), status: res.status, rateLimited: res.status === 429, block: parsed?.result || null };
  } catch (err) { return { ok: false, status: 0, rateLimited: false, error: shortError(err) }; }
}

async function collectChecks() {
  const [mainService, caddy, scannerHttp, historyExport, disk, rpc] = await Promise.all([
    serviceActive('rh-chain-monitor.service'),
    serviceActive('caddy.service'),
    fetchCheck('http://127.0.0.1:8080/health', true),
    fetchCheck('http://127.0.0.1:3105/health', true),
    diskCheck(),
    rpcCheck(),
  ]);
  const processes = {};
  for (const [key, pattern] of PROCESS_CHECKS) processes[key] = await processAlive(pattern);
  const publicRoutes = {};
  for (const [key, path] of PUBLIC_ROUTES) publicRoutes[key] = await fetchCheck(`${CFG.publicBase}${path}`);
  return {
    checkedAt: iso(),
    mainService, caddy, scannerHttp, historyExport, disk, rpc,
    db: dbCheck(), processes, publicRoutes,
    channels: { barkConfigured: Boolean(CFG.barkKey), telegramConfigured: Boolean(CFG.telegramToken && CFG.telegramChatId) },
  };
}

function incidentsFrom(checks) {
  const out = [];
  const push = (key, severity, message, restartable = false) => out.push({ key, severity, message, restartable });
  if (!checks.mainService.ok) push('main-service', 'CRITICAL', `主服务异常：${checks.mainService.detail}`, true);
  if (!checks.scannerHttp.ok) push('scanner-http', 'CRITICAL', `Scanner /health 异常 HTTP ${checks.scannerHttp.status || 0}`, true);
  if (!checks.historyExport.ok) push('history-export', 'CRITICAL', `History Export 异常 HTTP ${checks.historyExport.status || 0}`, true);
  for (const [key, status] of Object.entries(checks.processes)) if (!status.ok) push(key, 'CRITICAL', `${key} 进程缺失`, true);
  if (!checks.db.ok) push('sqlite', 'CRITICAL', `SQLite quick_check=${checks.db.quickCheck}${checks.db.error ? ` ${checks.db.error}` : ''}`, false);
  if (checks.db.opportunityAt && ageMs(checks.db.opportunityAt) > CFG.opportunityStaleMs) {
    push('opportunity-stale', 'CRITICAL', `Opportunity Pool 已 ${Math.round(ageMs(checks.db.opportunityAt)/1000)} 秒未刷新`, true);
  }
  if (!checks.caddy.ok) push('caddy', 'CRITICAL', `Caddy 异常：${checks.caddy.detail}`, false);
  const failedRoutes = Object.entries(checks.publicRoutes).filter(([, v]) => !v.ok).map(([k]) => k);
  if (failedRoutes.length) push('https-exports', 'WARN', `HTTPS 出口异常：${failedRoutes.join(', ')}`, false);
  if (!checks.rpc.ok) push('rpc', 'WARN', checks.rpc.rateLimited ? 'Robinhood RPC 触发 429 限流' : `Robinhood RPC 异常 HTTP ${checks.rpc.status || 0}`, false);
  if (checks.disk.usedPct != null && checks.disk.usedPct >= CFG.diskCriticalPct) push('disk', 'CRITICAL', `磁盘使用率 ${checks.disk.usedPct.toFixed(1)}%`, false);
  else if (checks.disk.warn) push('disk', 'WARN', `磁盘使用率 ${checks.disk.usedPct.toFixed(1)}%`, false);
  if (!checks.channels.barkConfigured || !checks.channels.telegramConfigured) push('channels', 'CRITICAL', 'Bark / Telegram 至少一个未配置', false);
  if (checks.db.alertFailures24h > 0) push('alert-channel-failures', 'WARN', `近24h存在 ${checks.db.alertFailures24h} 条提醒通道发送失败记录`, false);
  return out;
}

async function sendBark(title, body) {
  if (!CFG.barkKey) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${CFG.barkServer}/${encodeURIComponent(CFG.barkKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'rh-health-monitor/1.0' },
      body: JSON.stringify({ title, body, group: 'RH Chain System', level: 'timeSensitive' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) { return { ok: false, error: shortError(err) }; }
}
async function sendTelegram(title, body) {
  if (!CFG.telegramToken || !CFG.telegramChatId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'rh-health-monitor/1.0' },
      body: JSON.stringify({ chat_id: CFG.telegramChatId, text: `${title}\n${body}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) { return { ok: false, error: shortError(err) }; }
}
async function notify(title, body) {
  const [bark, telegram] = await Promise.all([sendBark(title, body), sendTelegram(title, body)]);
  console.log('[health notify]', JSON.stringify({ title, bark: bark.ok, telegram: telegram.ok, barkError: bark.error || '', telegramError: telegram.error || '' }));
  return { bark, telegram };
}

function failureCounts(state, incidents) {
  const active = new Set(incidents.map(x => x.key));
  const next = { ...(state.failures || {}) };
  const known = new Set([...Object.keys(next), ...active]);
  for (const key of known) next[key] = active.has(key) ? Number(next[key] || 0) + 1 : 0;
  return next;
}
async function maybeRestart(state, incidents, failures) {
  const restartable = incidents.filter(x => x.restartable && Number(failures[x.key] || 0) >= CFG.restartAfterFailures);
  if (!restartable.length) return { attempted: false };
  const last = new Date(state.lastRestartAt || 0).getTime();
  if (Number.isFinite(last) && Date.now() - last < CFG.restartCooldownMs) return { attempted: false, cooldown: true };
  const before = restartable.map(x => x.key);
  const r = await commandOk('systemctl', ['restart', 'rh-chain-monitor.service']);
  if (r.ok) await sleep(8000);
  console.log('[health auto-restart]', JSON.stringify({ ok: r.ok, reasons: before, error: r.error || '' }));
  return { attempted: true, ok: r.ok, reasons: before, at: iso(), error: r.error || '' };
}

function formatIncidents(incidents, restart) {
  const lines = incidents.slice(0, 8).map(x => `${x.severity === 'CRITICAL' ? '🔴' : '🟡'} ${x.message}`);
  if (restart?.attempted) lines.push(restart.ok ? `♻️ 已自动重启主服务：${restart.reasons.join(', ')}` : `❌ 自动重启失败：${restart.error}`);
  lines.push('交易信号提醒与系统告警相互独立。');
  return lines.join('\n');
}

export async function runHealthCycle({ forceNotify = false } = {}) {
  const state = await loadState();
  const checks = await collectChecks();
  let incidents = incidentsFrom(checks);
  const failures = failureCounts(state, incidents);
  const restart = await maybeRestart(state, incidents, failures);
  if (restart.attempted && restart.ok) {
    const post = await collectChecks();
    checks.afterRestart = post;
    incidents = incidentsFrom(post);
  }

  const previous = new Set(state.active || []);
  const current = new Set(incidents.map(x => x.key));
  const changed = previous.size !== current.size || [...current].some(x => !previous.has(x));
  const resolved = [...previous].filter(x => !current.has(x));
  const lastNotify = new Date(state.lastNotifyAt || 0).getTime();
  const reminderDue = incidents.length && (!Number.isFinite(lastNotify) || Date.now() - lastNotify >= CFG.reminderMs);
  const inGrace = Date.now() - startedAt < CFG.startupGraceMs;
  let notified = false;

  if (!inGrace && incidents.length && (changed || reminderDue || forceNotify)) {
    const critical = incidents.some(x => x.severity === 'CRITICAL');
    await notify(`${critical ? '⚠️' : '🟡'} RH Monitor 系统${critical ? '异常' : '提醒'}`, formatIncidents(incidents, restart));
    notified = true;
  } else if (!inGrace && !incidents.length && resolved.length) {
    await notify('✅ RH Monitor 已恢复', `已恢复：${resolved.join(', ')}\n扫描、评分、提醒与历史追踪继续运行。`);
    notified = true;
  }

  const nextState = {
    failures,
    active: [...current],
    lastNotifyAt: notified ? iso() : state.lastNotifyAt || null,
    lastRestartAt: restart.attempted ? restart.at : state.lastRestartAt || null,
    updatedAt: iso(),
  };
  const status = { ok: incidents.length === 0, incidents, restart, checks, monitor: { inGrace, pollMs: CFG.pollMs, reminderMs: CFG.reminderMs }, updatedAt: iso() };
  await atomicJson(CFG.statePath, nextState);
  await atomicJson(CFG.statusPath, status);
  console.log('[health monitor]', JSON.stringify({ ok: status.ok, incidents: incidents.map(x => x.key), restart: restart.attempted ? restart.ok : null, diskPct: checks.disk.usedPct, opportunityAgeSec: checks.db.opportunityAgeSec }));
  return status;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--test-notify')) {
    const result = await notify('✅ RH Monitor 健康监控已启用', '独立系统健康监控已经上线。异常会通过 Bark + Telegram 双通道推送，并对可恢复的主服务故障尝试自动重启。');
    console.log(JSON.stringify(result));
    return;
  }
  if (args.has('--once')) {
    const result = await runHealthCycle({ forceNotify: args.has('--force-notify') });
    console.log(JSON.stringify({ ok: result.ok, incidents: result.incidents }, null, 2));
    return;
  }
  console.log('[health monitor boot]', JSON.stringify({ pollMs: CFG.pollMs, restartAfterFailures: CFG.restartAfterFailures, diskWarnPct: CFG.diskWarnPct, diskCriticalPct: CFG.diskCriticalPct, publicBase: CFG.publicBase }));
  while (!stopping) {
    const started = Date.now();
    try { await runHealthCycle(); } catch (err) { console.error('[health monitor cycle]', err?.stack || err); }
    await sleep(Math.max(1000, CFG.pollMs - (Date.now() - started)));
  }
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error('[health monitor fatal]', err?.stack || err); process.exitCode = 1; });
