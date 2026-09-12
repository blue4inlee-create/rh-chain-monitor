import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, rm, statfs } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const CFG = {
  pollMs: Math.max(15_000, Number(process.env.HEALTH_POLL_MS || 30_000)),
  reminderMs: Math.max(300_000, Number(process.env.HEALTH_REMINDER_MS || 1_800_000)),
  startupGraceMs: Math.max(15_000, Number(process.env.HEALTH_STARTUP_GRACE_MS || 90_000)),
  restartAfter: Math.max(2, Number(process.env.HEALTH_RESTART_AFTER_FAILURES || 2)),
  restartCooldownMs: Math.max(300_000, Number(process.env.HEALTH_RESTART_COOLDOWN_MS || 600_000)),
  diskWarn: Number(process.env.HEALTH_DISK_WARN_PCT || 80),
  diskCritical: Number(process.env.HEALTH_DISK_CRITICAL_PCT || 92),
  opportunityStaleMs: Math.max(60_000, Number(process.env.HEALTH_OPPORTUNITY_STALE_MS || 180_000)),
  marketTickStaleMs: Math.max(120_000, Number(process.env.HEALTH_MARKET_TICK_STALE_MS || 300_000)),
  httpTimeoutMs: Math.max(3_000, Number(process.env.HEALTH_HTTP_TIMEOUT_MS || 6_500)),
  opportunityHttpTimeoutMs: Math.max(6_000, Number(process.env.HEALTH_OPPORTUNITY_HTTP_TIMEOUT_MS || 12_000)),
  httpsFailConfirmations: Math.max(2, Number(process.env.HEALTH_HTTPS_FAIL_CONFIRMATIONS || 2)),
  httpsRecoveryConfirmations: Math.max(2, Number(process.env.HEALTH_HTTPS_RECOVERY_CONFIRMATIONS || 2)),
  pushAlerts: ['1', 'true', 'yes', 'on'].includes(String(process.env.HEALTH_PUSH_ALERTS || 'false').trim().toLowerCase()),
  dbPath: String(process.env.SQLITE_PATH || '/data/rh_monitor.db'),
  statePath: String(process.env.HEALTH_STATE_PATH || '/data/rh_health_monitor_state.json'),
  statusPath: String(process.env.HEALTH_STATUS_PATH || '/data/rh_health_status.json'),
  poolAuditPath: String(process.env.POOL_DIVERGENCE_STATUS_PATH || '/data/pool_divergence_audit.json'),
  poolAuditStaleMs: Math.max(900_000, Number(process.env.HEALTH_POOL_AUDIT_STALE_MS || 1_800_000)),
  rpcUrl: String(process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com'),
  publicBase: String(process.env.HEALTH_PUBLIC_BASE || 'https://rh.192-236-234-216.sslip.io:8443').replace(/\/+$/, ''),
  barkServer: String(process.env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, ''),
  barkKey: String(process.env.BARK_DEVICE_KEY || '').trim(),
  telegramToken: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
};
const PUBLIC_ROUTES = {
  opportunity: '/sheet-opportunity-71d9b4c2e8f6.csv',
  history: '/sheet-history-4f0d7c91a2b8.csv',
  calibration: '/sheet-calibration-8e3a1f6b7c2d.csv',
  thresholds: '/sheet-thresholds-5a3d9c7e1b4f.csv',
  shadow: '/sheet-shadow-2c7e9a4d1f6b.csv',
  secondLeg: '/sheet-second-leg-6b2e4d8c1a9f.csv',
};
const PROCESSES = {
  alertWorker: 'alert_worker.mjs',
  secondLegWorker: 'second_leg_alert_worker.mjs',
  historyWorker: 'history_worker.mjs',
  opportunityWorker: 'opportunity_worker.mjs',
  shadowWorker: 'shadow_threshold_worker.mjs',
};
const bootMs = Date.now();
let stopping = false;
let sleepWake = null;
function sleep(ms) {
  return new Promise(resolve => {
    const wake = () => { clearTimeout(timer); if (sleepWake === wake) sleepWake = null; resolve(); };
    const timer = setTimeout(() => { if (sleepWake === wake) sleepWake = null; resolve(); }, ms);
    sleepWake = wake;
  });
}
const text = v => v == null ? '' : String(v).trim();
const nowIso = () => new Date().toISOString();
const errText = e => text(e?.message || e).slice(0, 200);
function ageMs(v) { const t = new Date(v || '').getTime(); return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity; }
export function isMarketTickStale(latestAt, nowMs = Date.now(), thresholdMs = CFG.marketTickStaleMs) {
  const t = new Date(latestAt || '').getTime();
  return !Number.isFinite(t) || Math.max(0, nowMs - t) > thresholdMs;
}

async function loadState() {
  try { return JSON.parse(await readFile(CFG.statePath, 'utf8')); }
  catch { return { active: [], failures: {}, httpsRoutes: {}, lastNotifyAt: null, lastRestartAt: null }; }
}
async function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch {}
    throw err;
  }
}
async function cmd(command, args = []) {
  try {
    const { stdout = '' } = await execFileAsync(command, args, { timeout: 5000 });
    return { ok: true, output: text(stdout) };
  } catch (e) { return { ok: false, output: text(e?.stdout), error: errText(e) }; }
}
async function service(name) {
  const r = await cmd('systemctl', ['is-active', name]);
  return { ok: r.ok && r.output === 'active', detail: r.output || r.error || 'inactive' };
}
async function processCheck(pattern) {
  const r = await cmd('pgrep', ['-af', pattern]);
  return { ok: r.ok && Boolean(r.output), detail: r.ok ? 'running' : 'missing' };
}
async function httpCheck(url, json = false, timeoutMs = CFG.httpTimeoutMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'rh-health-monitor/1.3' } });
    let body = null;
    if (json) { try { body = await r.json(); } catch {} }
    else { try { await r.body?.cancel(); } catch {} }
    return { ok: r.ok && (!json || body?.ok !== false), status: r.status, body };
  } catch (e) { return { ok: false, status: 0, error: errText(e) }; }
}
async function diskCheck() {
  try {
    const s = await statfs('/data');
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    const pct = total ? (1 - free / total) * 100 : 0;
    return { ok: pct < CFG.diskCritical, warn: pct >= CFG.diskWarn, usedPct: pct };
  } catch (e) { return { ok: false, warn: true, usedPct: null, error: errText(e) }; }
}
async function poolAuditCheck() {
  try {
    const data = JSON.parse(await readFile(CFG.poolAuditPath, 'utf8'));
    const age = ageMs(data.generatedAt);
    const stale = !Number.isFinite(age) || age > CFG.poolAuditStaleMs;
    const anomalyCount = Number(data.anomalyCount || 0);
    return {
      ok: !stale && anomalyCount === 0,
      stale,
      ageSec: Number.isFinite(age) ? Math.round(age / 1000) : null,
      anomalyCount,
      scanned: Number(data.scanned || 0),
      checked: Number(data.checked || 0),
      unverifiable: Number(data.unverifiable || 0),
      generatedAt: data.generatedAt || null,
      anomalies: Array.isArray(data.anomalies) ? data.anomalies.slice(0, 5) : [],
    };
  } catch (e) {
    return { ok: false, stale: true, ageSec: null, anomalyCount: 0, error: errText(e), anomalies: [] };
  }
}
function databaseCheck() {
  let db;
  try {
    db = new Database(CFG.dbPath, { readonly: true, fileMustExist: true, timeout: 4000 });
    const quick = text(db.pragma('quick_check', { simple: true })).toLowerCase();
    const table = n => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n));
    const opportunityAt = table('opportunity_pool') ? db.prepare('SELECT MAX(updated_at) at FROM opportunity_pool').get()?.at || null : null;
    const latestMarketTickAt = table('market_ticks') ? db.prepare('SELECT MAX(tick_at) at FROM market_ticks').get()?.at || null : null;
    const marketTicksRecent15m = table('market_ticks') ? Number(db.prepare("SELECT COUNT(*) n FROM market_ticks WHERE julianday(tick_at)>=julianday('now','-15 minutes')").get()?.n || 0) : 0;
    const marketTickAge = ageMs(latestMarketTickAt);
    const failedAlerts = table('alert_events') ? Number(db.prepare("SELECT COUNT(*) n FROM alert_events WHERE (bark_status='FAILED' OR telegram_status='FAILED')").get()?.n || 0) : 0;
    return {
      ok: quick === 'ok', quick, opportunityAt,
      opportunityAgeSec: Number.isFinite(ageMs(opportunityAt)) ? Math.round(ageMs(opportunityAt)/1000) : null,
      latestMarketTickAt,
      marketTickAgeSec: Number.isFinite(marketTickAge) ? Math.round(marketTickAge/1000) : null,
      marketTicksRecent15m,
      failedAlerts,
    };
  } catch (e) { return { ok: false, quick: 'error', opportunityAt: null, error: errText(e) }; }
  finally { try { db?.close(); } catch {} }
}
async function rpcCheck() {
  try {
    const r = await fetch(CFG.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'rh-health-monitor/1.3' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(CFG.httpTimeoutMs),
    });
    const raw = await r.text();
    let j = null; try { j = JSON.parse(raw); } catch {}
    return { ok: r.ok && Boolean(j?.result), status: r.status, rateLimited: r.status === 429, block: j?.result || null };
  } catch (e) { return { ok: false, status: 0, rateLimited: false, error: errText(e) }; }
}

async function collect() {
  const [main, caddy, scanner, history, disk, rpc, poolAudit] = await Promise.all([
    service('rh-chain-monitor.service'), service('caddy.service'),
    httpCheck('http://127.0.0.1:8080/health', true), httpCheck('http://127.0.0.1:3105/health', true),
    diskCheck(), rpcCheck(), poolAuditCheck(),
  ]);
  const processEntries = await Promise.all(Object.entries(PROCESSES).map(async ([k, p]) => [k, await processCheck(p)]));
  const processes = Object.fromEntries(processEntries);
  const routeEntries = await Promise.all(Object.entries(PUBLIC_ROUTES).map(async ([k, p]) => {
    const timeoutMs = k === 'opportunity' ? CFG.opportunityHttpTimeoutMs : CFG.httpTimeoutMs;
    return [k, await httpCheck(`${CFG.publicBase}${p}`, false, timeoutMs)];
  }));
  const publicRoutes = Object.fromEntries(routeEntries);
  return {
    checkedAt: nowIso(), main, caddy, scanner, history, disk, rpc, poolAudit,
    db: databaseCheck(), processes, publicRoutes,
    channels: { bark: Boolean(CFG.barkKey), telegram: Boolean(CFG.telegramToken && CFG.telegramChatId) },
  };
}

export function advanceHttpsRouteState(previous = {}, publicRoutes = {}, failConfirmations = CFG.httpsFailConfirmations, recoveryConfirmations = CFG.httpsRecoveryConfirmations) {
  const out = {};
  for (const [key, result] of Object.entries(publicRoutes || {})) {
    const prior = previous?.[key] || {};
    const priorIncident = Boolean(prior.incident);
    let failures = 0;
    let successes = 0;
    let incident = priorIncident;
    if (result?.ok) {
      failures = 0;
      successes = Number(prior.successes || 0) + 1;
      if (priorIncident && successes >= recoveryConfirmations) incident = false;
    } else {
      failures = Number(prior.failures || 0) + 1;
      successes = 0;
      if (!priorIncident && failures >= failConfirmations) incident = true;
    }
    out[key] = {
      failures,
      successes,
      incident,
      lastOk: Boolean(result?.ok),
      status: Number(result?.status || 0),
      error: text(result?.error || '').slice(0, 120),
    };
  }
  return out;
}

function incidents(checks, httpsRoutes = {}) {
  const x = [];
  const add = (key, severity, message, restartable = false) => x.push({ key, severity, message, restartable });
  if (!checks.main.ok) add('main-service', 'CRITICAL', `主服务异常：${checks.main.detail}`, true);
  if (!checks.scanner.ok) add('scanner-http', 'CRITICAL', `Scanner /health 异常 HTTP ${checks.scanner.status || 0}`, true);
  if (!checks.history.ok) add('history-export', 'CRITICAL', `History Export 异常 HTTP ${checks.history.status || 0}`, true);
  for (const [k, v] of Object.entries(checks.processes)) if (!v.ok) add(k, 'CRITICAL', `${k} 进程缺失`, true);
  if (!checks.db.ok) add('sqlite', 'CRITICAL', `SQLite quick_check=${checks.db.quick}${checks.db.error ? ` ${checks.db.error}` : ''}`);
  if (checks.db.opportunityAt && ageMs(checks.db.opportunityAt) > CFG.opportunityStaleMs) add('opportunity-stale', 'CRITICAL', `Opportunity Pool 已 ${Math.round(ageMs(checks.db.opportunityAt)/1000)} 秒未刷新`, true);
  if (isMarketTickStale(checks.db.latestMarketTickAt)) add('market-ticks-stale', 'CRITICAL', checks.db.latestMarketTickAt
    ? `Market ticks 已 ${checks.db.marketTickAgeSec ?? '?'} 秒未刷新`
    : 'Market ticks 尚无有效数据', true);
  if (!checks.caddy.ok) add('caddy', 'CRITICAL', `Caddy 异常：${checks.caddy.detail}`);
  const badRoutes = Object.entries(httpsRoutes).filter(([, v]) => v.incident).map(([k]) => k);
  if (badRoutes.length) add('https-exports', 'WARN', `HTTPS 出口连续异常：${badRoutes.join(', ')}`);
  if (!checks.rpc.ok) add('rpc', 'WARN', checks.rpc.rateLimited ? 'Robinhood RPC 触发 429 限流' : `Robinhood RPC 异常 HTTP ${checks.rpc.status || 0}`);
  if (checks.poolAudit?.stale) add('pool-audit-stale', 'WARN', `跨池巡检未更新${checks.poolAudit.ageSec != null ? `：${checks.poolAudit.ageSec} 秒` : ''}`);
  else if ((checks.poolAudit?.anomalyCount || 0) > 0) add('pool-divergence', 'WARN', `发现 ${checks.poolAudit.anomalyCount} 个跨池价格/ATH 异常候选`);
  if (checks.disk.usedPct != null && checks.disk.usedPct >= CFG.diskCritical) add('disk', 'CRITICAL', `磁盘使用率 ${checks.disk.usedPct.toFixed(1)}%`);
  else if (checks.disk.warn) add('disk', 'WARN', `磁盘使用率 ${checks.disk.usedPct.toFixed(1)}%`);
  if (CFG.pushAlerts && (!checks.channels.bark || !checks.channels.telegram)) add('channels', 'CRITICAL', 'Bark / Telegram 至少一个未配置');
  if ((checks.db.failedAlerts || 0) > 0) add('alert-failures', 'WARN', `提醒历史中存在 ${checks.db.failedAlerts} 条通道失败记录`);
  return x;
}

async function sendBark(title, body) {
  if (!CFG.barkKey) return { ok: false, skipped: true };
  try {
    const r = await fetch(`${CFG.barkServer}/${encodeURIComponent(CFG.barkKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, group: 'RH Chain System', level: 'timeSensitive' }), signal: AbortSignal.timeout(10000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
async function sendTelegram(title, body) {
  if (!CFG.telegramToken || !CFG.telegramChatId) return { ok: false, skipped: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.telegramChatId, text: `${title}\n${body}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
async function notify(title, body) {
  const [bark, telegram] = await Promise.all([sendBark(title, body), sendTelegram(title, body)]);
  console.log('[health notify]', JSON.stringify({ title, bark: bark.ok, telegram: telegram.ok, barkError: bark.error || '', telegramError: telegram.error || '' }));
  return { bark, telegram };
}
function nextFailures(old, list) {
  const active = new Set(list.map(i => i.key));
  const out = { ...(old || {}) };
  for (const key of new Set([...Object.keys(out), ...active])) out[key] = active.has(key) ? Number(out[key] || 0) + 1 : 0;
  return out;
}
async function maybeRestart(state, list, failures) {
  const reasons = list.filter(i => i.restartable && Number(failures[i.key] || 0) >= CFG.restartAfter).map(i => i.key);
  if (!reasons.length) return { attempted: false };
  const last = new Date(state.lastRestartAt || 0).getTime();
  if (Number.isFinite(last) && Date.now() - last < CFG.restartCooldownMs) return { attempted: false, cooldown: true };
  const r = await cmd('systemctl', ['restart', 'rh-chain-monitor.service']);
  if (r.ok) await sleep(8000);
  const result = { attempted: true, ok: r.ok, reasons, at: nowIso(), error: r.error || '' };
  console.log('[health auto-restart]', JSON.stringify(result));
  return result;
}
function bodyFor(list, restart) {
  const lines = list.slice(0, 8).map(i => `${i.severity === 'CRITICAL' ? '🔴' : '🟡'} ${i.message}`);
  if (restart.attempted) lines.push(restart.ok ? `♻️ 已自动重启主服务：${restart.reasons.join(', ')}` : `❌ 自动重启失败：${restart.error}`);
  lines.push('系统告警与买币提醒相互独立。');
  return lines.join('\n');
}

export async function runCycle({ forceNotify = false } = {}) {
  const state = await loadState();
  let checks = await collect();
  let httpsRoutes = advanceHttpsRouteState(state.httpsRoutes || {}, checks.publicRoutes);
  let list = incidents(checks, httpsRoutes);
  const failures = nextFailures(state.failures, list);
  const restart = await maybeRestart(state, list, failures);
  if (restart.attempted && restart.ok) {
    checks = await collect();
    httpsRoutes = advanceHttpsRouteState(httpsRoutes, checks.publicRoutes);
    list = incidents(checks, httpsRoutes);
  }

  const prev = new Set(state.active || []), cur = new Set(list.map(i => i.key));
  const changed = prev.size !== cur.size || [...cur].some(k => !prev.has(k));
  const resolved = [...prev].filter(k => !cur.has(k));
  const lastNotify = new Date(state.lastNotifyAt || 0).getTime();
  const reminder = list.length && (!Number.isFinite(lastNotify) || Date.now() - lastNotify >= CFG.reminderMs);
  const grace = Date.now() - bootMs < CFG.startupGraceMs;
  let notified = false;
  if (CFG.pushAlerts && !grace && list.length && (changed || reminder || forceNotify)) {
    await notify(`${list.some(i => i.severity === 'CRITICAL') ? '⚠️' : '🟡'} RH Monitor 系统异常`, bodyFor(list, restart));
    notified = true;
  } else if (CFG.pushAlerts && !grace && !list.length && resolved.length) {
    await notify('✅ RH Monitor 已恢复', `已恢复：${resolved.join(', ')}\n扫描、评分、提醒、历史追踪与 Shadow 继续运行。`);
    notified = true;
  }
  const next = {
    active: [...cur],
    failures,
    httpsRoutes,
    lastNotifyAt: notified ? nowIso() : state.lastNotifyAt || null,
    lastRestartAt: restart.attempted ? restart.at : state.lastRestartAt || null,
    updatedAt: nowIso(),
  };
  const status = {
    ok: list.length === 0,
    incidents: list,
    restart,
    checks,
    httpsRoutes,
    monitor: {
      grace,
      pushAlerts: CFG.pushAlerts,
      pollMs: CFG.pollMs,
      httpTimeoutMs: CFG.httpTimeoutMs,
      opportunityHttpTimeoutMs: CFG.opportunityHttpTimeoutMs,
      marketTickStaleMs: CFG.marketTickStaleMs,
      httpsFailConfirmations: CFG.httpsFailConfirmations,
      httpsRecoveryConfirmations: CFG.httpsRecoveryConfirmations,
    },
    updatedAt: nowIso(),
  };
  await writeJson(CFG.statePath, next);
  await writeJson(CFG.statusPath, status);
  const httpsPending = Object.entries(httpsRoutes)
    .filter(([, v]) => v.incident || v.failures > 0)
    .map(([k, v]) => `${k}:${v.incident ? 'incident' : `fail${v.failures}`}`);
  console.log('[health monitor]', JSON.stringify({
    ok: status.ok,
    incidents: list.map(i => i.key),
    restart: restart.attempted ? restart.ok : null,
    diskPct: checks.disk.usedPct,
    opportunityAgeSec: checks.db.opportunityAgeSec,
    marketTickAgeSec: checks.db.marketTickAgeSec,
    marketTicksRecent15m: checks.db.marketTicksRecent15m,
    pushAlerts: CFG.pushAlerts,
    httpsPending,
    poolAuditAnomalies: checks.poolAudit?.anomalyCount || 0,
    poolAuditAgeSec: checks.poolAudit?.ageSec ?? null,
  }));
  return status;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--test-notify')) {
    if (!CFG.pushAlerts) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'HEALTH_PUSH_ALERTS=false' }));
      return;
    }
    console.log(JSON.stringify(await notify('✅ RH Monitor 健康监控已启用', '独立健康监控已上线。异常会通过 Bark + Telegram 推送；连续主服务故障会尝试自动重启。')));
    return;
  }
  if (args.has('--once')) {
    const r = await runCycle({ forceNotify: args.has('--force-notify') });
    console.log(JSON.stringify({ ok: r.ok, incidents: r.incidents }, null, 2));
    return;
  }
  console.log('[health monitor boot]', JSON.stringify({
    pollMs: CFG.pollMs,
    restartAfter: CFG.restartAfter,
    diskWarn: CFG.diskWarn,
    diskCritical: CFG.diskCritical,
    pushAlerts: CFG.pushAlerts,
    httpTimeoutMs: CFG.httpTimeoutMs,
    opportunityHttpTimeoutMs: CFG.opportunityHttpTimeoutMs,
    marketTickStaleMs: CFG.marketTickStaleMs,
    httpsFailConfirmations: CFG.httpsFailConfirmations,
    httpsRecoveryConfirmations: CFG.httpsRecoveryConfirmations,
  }));
  while (!stopping) {
    const t = Date.now();
    try { await runCycle(); } catch (e) { console.error('[health monitor cycle]', e?.stack || e); }
    await sleep(Math.max(1000, CFG.pollMs - (Date.now() - t)));
  }
}
function requestStop() { stopping = true; if (sleepWake) sleepWake(); }
process.on('SIGTERM', requestStop);
process.on('SIGINT', requestStop);
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('[health monitor fatal]', e?.stack || e); process.exitCode = 1; });
