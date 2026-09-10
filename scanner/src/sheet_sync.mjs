import { initializeDatabase, getDatabase, getDatabaseHealth, closeDatabase } from './db.mjs';
import { initializeDeadLetterStore, getDeadLetterStats } from './dead_letter.mjs';
import { ensurePriceMilestoneSchema } from './price_milestones.mjs';
import { ensureAthSchema, getAthHealth } from './ath_metrics.mjs';
import { ensureScoreSchema } from './scoring.mjs';
import { ensureRiskSchema } from './risk.mjs';
import { ensureStageSchema, getStageHealth } from './stages.mjs';

const VERSION = '2.13.0';
const CFG = {
  webhookUrl: String(process.env.RESULT_SHEET_WEBHOOK_URL || process.env.SHEET_WEBHOOK_URL || '').trim(),
  secret: String(process.env.SHEET_INGEST_SECRET || '').trim(),
  intervalMs: Math.max(60_000, Number(process.env.SHEET_SYNC_INTERVAL_MS || 300_000)),
  discoveryLimit: Math.max(50, Math.min(900, Number(process.env.SHEET_SYNC_DISCOVERY_LIMIT || 500))),
  stageLimit: Math.max(50, Math.min(900, Number(process.env.SHEET_SYNC_STAGE_LIMIT || 500))),
};

let stopping = false;

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safe(v) { return v == null ? '' : v; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function shortJson(v, max = 500) {
  const s = text(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function ratio(buys, sells) {
  const b = num(buys), s = num(sells);
  if (b == null || s == null) return '';
  return (b + 1) / (s + 1);
}

function prepareLookups(db) {
  return {
    pool: db.prepare(`
      SELECT * FROM pools WHERE token_address=?
      ORDER BY discovered_at ASC, id ASC LIMIT 1
    `),
    latestSnapshot: db.prepare(`
      SELECT * FROM snapshots WHERE token_address=?
      ORDER BY snapshot_at DESC, id DESC LIMIT 1
    `),
    initialSnapshot: db.prepare(`
      SELECT * FROM snapshots WHERE token_address=?
      ORDER BY snapshot_at ASC, id ASC LIMIT 1
    `),
    latestScore: db.prepare(`
      SELECT * FROM scores WHERE token_address=?
      ORDER BY scored_at DESC, id DESC LIMIT 1
    `),
    stageEntry: db.prepare(`
      SELECT * FROM stage_history
      WHERE token_address=? AND to_stage='CANARY'
      ORDER BY changed_at ASC, id ASC LIMIT 1
    `),
    latestTick: db.prepare(`
      SELECT * FROM market_ticks WHERE token_address=?
      ORDER BY tick_at DESC, id DESC LIMIT 1
    `),
    riskRows: db.prepare(`
      SELECT check_name, status, severity, value, details
      FROM risk_checks
      WHERE token_address=? AND snapshot_type=?
      ORDER BY severity DESC, check_name ASC
    `),
    snapshotNear: db.prepare(`
      SELECT * FROM snapshots WHERE token_address=?
      ORDER BY ABS(julianday(snapshot_at) - julianday(?)) ASC, id DESC LIMIT 1
    `),
  };
}

function summarizeRisk(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = list.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1;
    return a;
  }, {});
  const hard = list.filter(r => r.status === 'FAIL').map(r => r.check_name);
  const warnings = list.filter(r => r.status === 'WARN').map(r => r.check_name);
  const unknown = Number(counts.UNKNOWN || 0);
  let safety = '待验证';
  if (hard.length) safety = `FAIL ${hard.join(',')}`;
  else if (warnings.length) safety = `WARN ${warnings.join(',')}`;
  else if (list.length) safety = unknown ? `PASS + ${unknown} UNKNOWN` : 'PASS';
  const detail = list
    .filter(r => r.status !== 'PASS')
    .map(r => `${r.check_name}:${r.status}`)
    .join(' | ');
  return { safety, detail, counts };
}

function discoveryRows(db, lookup) {
  const tokens = db.prepare(`
    SELECT * FROM tokens
    ORDER BY first_seen_at DESC, token_address ASC
    LIMIT ?
  `).all(CFG.discoveryLimit);
  const now = Date.now();
  return tokens.map(t => {
    const pool = lookup.pool.get(t.token_address) || {};
    const latest = lookup.latestSnapshot.get(t.token_address) || {};
    const initial = lookup.initialSnapshot.get(t.token_address) || {};
    const score = lookup.latestScore.get(t.token_address) || {};
    const risks = summarizeRisk(lookup.riskRows.all(t.token_address, text(latest.snapshot_type)));
    const ageSec = Math.max(0, Math.round((now - new Date(t.first_seen_at).getTime()) / 1000));
    const txCount = num(latest.buy_count) != null && num(latest.sell_count) != null
      ? Number(latest.buy_count) + Number(latest.sell_count) : '';
    const mechanism = text(pool.pool_version) || (/pons/i.test(text(t.first_source)) ? 'Curve' : '');
    return [
      safe(t.first_seen_at), safe(t.discovery_block), ageSec, safe(t.symbol), t.token_address,
      safe(t.first_source), safe(pool.source || t.first_source), safe(pool.pool_key || t.first_pool_key),
      safe(pool.quote_token), safe(pool.quote_symbol), safe(t.discovery_price_usd),
      safe(t.discovery_market_cap), safe(initial.liquidity_usd), '', txCount,
      safe(latest.buy_count), safe(latest.sell_count), safe(t.creator_address), safe(latest.holder_count), '',
      risks.safety, mechanism, safe(score.final_score), safe(score.confidence), safe(t.monitor_stage || 'DISCOVERY'),
      shortJson([risks.detail, latest.source_status].filter(Boolean).join(' | '), 700),
      safe(pool.pool_key || t.first_pool_key), '', mechanism, safe(t.discovery_tx), ''
    ];
  });
}

function canaryRows(db, lookup) {
  const tokens = db.prepare(`
    SELECT * FROM tokens
    WHERE canary_at IS NOT NULL
    ORDER BY canary_at DESC, token_address ASC
    LIMIT 500
  `).all();
  return tokens.map(t => {
    const pool = lookup.pool.get(t.token_address) || {};
    const latest = lookup.latestSnapshot.get(t.token_address) || {};
    const initial = lookup.initialSnapshot.get(t.token_address) || {};
    const score = lookup.latestScore.get(t.token_address) || {};
    const entry = lookup.stageEntry.get(t.token_address) || {};
    const entrySnap = t.canary_at ? (lookup.snapshotNear.get(t.token_address, t.canary_at) || {}) : {};
    const tick = lookup.latestTick.get(t.token_address) || {};
    const risks = summarizeRisk(lookup.riskRows.all(t.token_address, text(latest.snapshot_type)));
    const currentMultiple = Number(t.canary_price_usd) > 0 && num(t.current_price_usd) != null
      ? Number(t.current_price_usd) / Number(t.canary_price_usd) : '';
    const mechanism = text(pool.pool_version) || (/pons/i.test(text(t.first_source)) ? 'Curve' : '');
    return [
      safe(t.canary_at), safe(t.symbol), t.token_address, safe(t.first_source), safe(t.canary_price_usd),
      safe(t.canary_market_cap), safe(entrySnap.liquidity_usd), safe(t.current_price_usd),
      safe(t.current_market_cap), safe(t.current_liquidity_usd), currentMultiple,
      safe(t.max_multiple_canary), '', safe(tick.volume_5m), safe(tick.buy_count_5m), safe(tick.sell_count_5m),
      '', '', mechanism, '', safe(score.final_score), safe(entry.score_at_change),
      safe(t.monitor_stage || 'CANARY'), '', risks.detail, safe(t.current_price_at || t.updated_at),
      safe(t.discovery_price_usd), safe(t.discovery_market_cap), safe(initial.liquidity_usd),
      shortJson(`ATH=${safe(t.canary_ath_price_usd)} | Risk=${risks.safety}`, 500),
      safe(pool.pool_key || t.first_pool_key), '', mechanism
    ];
  });
}

function stageRows(db, lookup) {
  const rows = db.prepare(`
    SELECT h.*, t.symbol
    FROM stage_history h
    LEFT JOIN tokens t ON t.token_address=h.token_address
    ORDER BY h.changed_at DESC, h.id DESC
    LIMIT ?
  `).all(CFG.stageLimit);
  return rows.map(h => {
    const snap = lookup.snapshotNear.get(h.token_address, h.changed_at) || {};
    return [
      safe(h.changed_at), safe(h.symbol), h.token_address, safe(h.from_stage), safe(h.to_stage),
      safe(h.reason), shortJson(h.reason_json, 700), '', safe(h.price_at_change), safe(h.market_cap_at_change),
      safe(snap.liquidity_usd), safe(snap.holder_count), safe(snap.volume_total_usd),
      ratio(snap.buy_count, snap.sell_count), '', '', '', safe(h.score_at_change),
      safe(h.confidence_at_change), safe(h.score_version)
    ];
  });
}

export function buildSheetPayload() {
  initializeDatabase();
  initializeDeadLetterStore();
  ensurePriceMilestoneSchema();
  ensureAthSchema();
  ensureScoreSchema();
  ensureRiskSchema();
  ensureStageSchema();
  const db = getDatabase();
  const lookup = prepareLookups(db);
  const dead = getDeadLetterStats();
  const dbHealth = getDatabaseHealth();
  const ath = getAthHealth();
  const stages = getStageHealth();
  return {
    kind: 'result_sync_v1',
    generatedAt: new Date().toISOString(),
    version: VERSION,
    sheets: {
      '新币发现': discoveryRows(db, lookup),
      'Canary跟踪': canaryRows(db, lookup),
      '阶段升级记录': stageRows(db, lookup),
    },
    health: {
      ...dbHealth,
      failedJobs: dbHealth.dbFailedJobs,
      deadLetterOpen: dead.open,
      marketTicks: ath.marketTicks,
      canaries: ath.canaries,
      stages: stages.stages,
    },
  };
}

async function postPayload(payload) {
  if (!CFG.webhookUrl) throw new Error('RESULT_SHEET_WEBHOOK_URL_missing');
  if (!CFG.secret) throw new Error('SHEET_INGEST_SECRET_missing');
  const res = await fetch(CFG.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `rh-sheet-sync/${VERSION}` },
    body: JSON.stringify({ ...payload, secret: CFG.secret }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  if (!res.ok || parsed?.ok === false) throw new Error(`sheet_sync_${res.status}:${body.slice(0, 300)}`);
  return parsed || { ok: true, status: res.status };
}

async function syncOnce() {
  const payload = buildSheetPayload();
  const result = await postPayload(payload);
  console.log('[sheet sync]', JSON.stringify({
    generatedAt: payload.generatedAt,
    discoveries: payload.sheets['新币发现'].length,
    canaries: payload.sheets['Canary跟踪'].length,
    stages: payload.sheets['阶段升级记录'].length,
    failedJobs: payload.health.failedJobs,
    deadLetterOpen: payload.health.deadLetterOpen,
    ok: result?.ok !== false,
  }));
  return result;
}

async function main() {
  initializeDatabase();
  if (!CFG.webhookUrl) {
    console.log('[sheet sync disabled]', JSON.stringify({ reason: 'webhook_url_missing', version: VERSION }));
    return;
  }
  if (!CFG.secret) {
    console.log('[sheet sync disabled]', JSON.stringify({ reason: 'ingest_secret_missing', version: VERSION }));
    return;
  }
  console.log('[sheet sync boot]', JSON.stringify({
    version: VERSION,
    intervalMs: CFG.intervalMs,
    discoveryLimit: CFG.discoveryLimit,
    stageLimit: CFG.stageLimit,
  }));
  while (!stopping) {
    try { await syncOnce(); }
    catch (err) { console.error('[sheet sync error]', text(err?.message || err)); }
    await sleep(CFG.intervalMs);
  }
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

main().catch(err => {
  console.error('[sheet sync fatal]', err);
  process.exitCode = 1;
}).finally(() => {
  try { closeDatabase(); } catch {}
});
