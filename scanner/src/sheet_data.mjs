import { initializeDatabase, getDatabase, getDatabaseHealth } from './db.mjs';
import { initializeDeadLetterStore, getDeadLetterStats } from './dead_letter.mjs';
import { ensurePriceMilestoneSchema } from './price_milestones.mjs';
import { ensureAthSchema, getAthHealth } from './ath_metrics.mjs';
import { ensureScoreSchema } from './scoring.mjs';
import { ensureRiskSchema } from './risk.mjs';
import { ensureStageSchema, getStageHealth } from './stages.mjs';

export const RESULT_VERSION = '2.16.0';

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safe(v) { return v == null ? '' : v; }
function shortJson(v, max = 500) {
  const s = text(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function ratio(buys, sells) {
  const b = num(buys), s = num(sells);
  if (b == null || s == null) return '';
  return (b + 1) / (s + 1);
}
function minutesBetween(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 60_000) * 100) / 100;
}
function canaryPathStats(ticks, entryPrice, canaryAt) {
  const entry = num(entryPrice);
  if (!(entry > 0)) return { maxDrawdown: null, time2x: null, time5x: null, time10x: null };
  const valid = (Array.isArray(ticks) ? ticks : [])
    .map(r => ({ at: r.tick_at, price: num(r.price_usd) }))
    .filter(r => r.price != null && r.price > 0);
  if (!valid.length) return { maxDrawdown: null, time2x: null, time5x: null, time10x: null };

  let peak = entry;
  let maxDrawdown = 0;
  let time2x = null;
  let time5x = null;
  let time10x = null;
  for (const tick of valid) {
    const multiple = tick.price / entry;
    if (time2x == null && multiple >= 2) time2x = minutesBetween(canaryAt, tick.at);
    if (time5x == null && multiple >= 5) time5x = minutesBetween(canaryAt, tick.at);
    if (time10x == null && multiple >= 10) time10x = minutesBetween(canaryAt, tick.at);
    if (tick.price > peak) peak = tick.price;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - tick.price) / peak);
  }
  return { maxDrawdown, time2x, time5x, time10x };
}

function prepareLookups(db) {
  const hasMarlin30 = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='marlin_30s'").get());
  return {
    pool: db.prepare(`SELECT * FROM pools WHERE token_address=? ORDER BY discovered_at ASC, id ASC LIMIT 1`),
    latestSnapshot: db.prepare(`SELECT * FROM snapshots WHERE token_address=? ORDER BY snapshot_at DESC, id DESC LIMIT 1`),
    initialSnapshot: db.prepare(`SELECT * FROM snapshots WHERE token_address=? ORDER BY snapshot_at ASC, id ASC LIMIT 1`),
    latestScore: db.prepare(`SELECT * FROM scores WHERE token_address=? ORDER BY scored_at DESC, id DESC LIMIT 1`),
    stageEntry: db.prepare(`SELECT * FROM stage_history WHERE token_address=? AND to_stage='CANARY' ORDER BY changed_at ASC, id ASC LIMIT 1`),
    latestTick: db.prepare(`SELECT * FROM market_ticks WHERE token_address=? ORDER BY tick_at DESC, id DESC LIMIT 1`),
    canaryTicks: db.prepare(`SELECT tick_at, price_usd FROM market_ticks WHERE token_address=? AND tick_at>=? AND price_usd IS NOT NULL ORDER BY tick_at ASC, id ASC`),
    riskRows: db.prepare(`SELECT check_name, status, severity, value, details FROM risk_checks WHERE token_address=? AND snapshot_type=? ORDER BY severity DESC, check_name ASC`),
    snapshotNear: db.prepare(`SELECT * FROM snapshots WHERE token_address=? ORDER BY ABS(julianday(snapshot_at) - julianday(?)) ASC, id DESC LIMIT 1`),
    marlin30: hasMarlin30 ? db.prepare(`SELECT * FROM marlin_30s WHERE token_address=? LIMIT 1`) : null,
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
  const detail = list.filter(r => r.status !== 'PASS').map(r => `${r.check_name}:${r.status}`).join(' | ');
  return { safety, detail, counts };
}

function discoveryRows(db, lookup, limit) {
  const tokens = db.prepare(`SELECT * FROM tokens ORDER BY first_seen_at DESC, token_address ASC LIMIT ?`).all(limit);
  const now = Date.now();
  return tokens.map(t => {
    const pool = lookup.pool.get(t.token_address) || {};
    const latest = lookup.latestSnapshot.get(t.token_address) || {};
    const initial = lookup.initialSnapshot.get(t.token_address) || {};
    const score = lookup.latestScore.get(t.token_address) || {};
    const m30 = lookup.marlin30 ? (lookup.marlin30.get(t.token_address) || {}) : {};
    const risks = summarizeRisk(lookup.riskRows.all(t.token_address, text(latest.snapshot_type)));
    const ageSec = Math.max(0, Math.round((now - new Date(t.first_seen_at).getTime()) / 1000));
    const txCount = num(latest.buy_count) != null && num(latest.sell_count) != null
      ? Number(latest.buy_count) + Number(latest.sell_count) : '';
    const mechanism = text(pool.pool_version) || (/pons/i.test(text(t.first_source)) ? 'Curve' : '');
    const discoveryMax = num(t.max_multiple_discovery);
    const discoveryNow = Number(t.discovery_price_usd) > 0 && num(t.current_price_usd) != null
      ? Number(t.current_price_usd) / Number(t.discovery_price_usd) : null;
    const tracking = [
      discoveryMax != null ? `DiscoveryMax=${discoveryMax.toFixed(3)}x` : '',
      discoveryNow != null ? `DiscoveryNow=${discoveryNow.toFixed(3)}x` : '',
    ].filter(Boolean).join(' | ');
    const marlin = [
      num(m30.age_sec) != null ? `M30@${Number(m30.age_sec).toFixed(1)}s` : '',
      num(m30.price_change_pct) != null ? `M30Δ=${Number(m30.price_change_pct).toFixed(1)}%` : '',
      num(m30.reserve_usd) != null ? `M30Reserve=$${Number(m30.reserve_usd).toFixed(0)}` : '',
      num(m30.curve_progress_pct) != null ? `M30Progress=${Number(m30.curve_progress_pct).toFixed(1)}%` : '',
      num(m30.score_at_observation) != null ? `M30Score=${Number(m30.score_at_observation).toFixed(1)}` : '',
      Number(m30.graduated || 0) === 1 ? 'M30Graduated=1' : '',
    ].filter(Boolean).join(' | ');
    return [
      safe(t.first_seen_at), safe(t.discovery_block), ageSec, safe(t.symbol), t.token_address,
      safe(t.first_source), safe(pool.source || t.first_source), safe(pool.pool_key || t.first_pool_key),
      safe(pool.quote_token), safe(pool.quote_symbol), safe(t.discovery_price_usd), safe(t.discovery_market_cap),
      safe(initial.liquidity_usd), '', txCount, safe(latest.buy_count), safe(latest.sell_count),
      safe(t.creator_address), safe(latest.holder_count), '', risks.safety, mechanism,
      safe(score.final_score), safe(score.confidence), safe(t.monitor_stage || 'DISCOVERY'),
      shortJson([risks.detail, latest.source_status, tracking, marlin].filter(Boolean).join(' | '), 700),
      safe(pool.pool_key || t.first_pool_key), '', mechanism, safe(t.discovery_tx), ''
    ];
  });
}

function canaryRows(db, lookup) {
  const tokens = db.prepare(`SELECT * FROM tokens WHERE canary_at IS NOT NULL ORDER BY canary_at DESC, token_address ASC LIMIT 500`).all();
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
    const ticks = t.canary_at ? lookup.canaryTicks.all(t.token_address, t.canary_at) : [];
    const path = canaryPathStats(ticks, t.canary_price_usd, t.canary_at);
    const athMinutes = t.canary_at && t.canary_ath_at ? minutesBetween(t.canary_at, t.canary_ath_at) : null;
    const timing = [
      path.time2x != null ? `T2x=${path.time2x}m` : '',
      path.time5x != null ? `T5x=${path.time5x}m` : '',
      path.time10x != null ? `T10x=${path.time10x}m` : '',
      athMinutes != null ? `ATHin=${athMinutes}m` : '',
    ].filter(Boolean).join(' | ');
    return [
      safe(t.canary_at), safe(t.symbol), t.token_address, safe(t.first_source), safe(t.canary_price_usd),
      safe(t.canary_market_cap), safe(entrySnap.liquidity_usd), safe(t.current_price_usd), safe(t.current_market_cap),
      safe(t.current_liquidity_usd), currentMultiple, safe(t.max_multiple_canary), safe(path.maxDrawdown), safe(tick.volume_5m),
      safe(tick.buy_count_5m), safe(tick.sell_count_5m), '', '', mechanism, '', safe(score.final_score),
      safe(entry.score_at_change), safe(t.monitor_stage || 'CANARY'), '', risks.detail,
      safe(t.current_price_at || t.updated_at), safe(t.discovery_price_usd), safe(t.discovery_market_cap),
      safe(initial.liquidity_usd), shortJson([`ATH=${safe(t.canary_ath_price_usd)}`, timing, `Risk=${risks.safety}`].filter(Boolean).join(' | '), 500),
      safe(pool.pool_key || t.first_pool_key), '', mechanism
    ];
  });
}

function stageRows(db, lookup, limit) {
  const rows = db.prepare(`
    SELECT h.*, t.symbol FROM stage_history h
    LEFT JOIN tokens t ON t.token_address=h.token_address
    ORDER BY h.changed_at DESC, h.id DESC LIMIT ?
  `).all(limit);
  return rows.map(h => {
    const snap = lookup.snapshotNear.get(h.token_address, h.changed_at) || {};
    return [
      safe(h.changed_at), safe(h.symbol), h.token_address, safe(h.from_stage), safe(h.to_stage), safe(h.reason),
      shortJson(h.reason_json, 700), '', safe(h.price_at_change), safe(h.market_cap_at_change), safe(snap.liquidity_usd),
      safe(snap.holder_count), safe(snap.volume_total_usd), ratio(snap.buy_count, snap.sell_count), '', '', '',
      safe(h.score_at_change), safe(h.confidence_at_change), safe(h.score_version)
    ];
  });
}

export function buildSheetPayload({ discoveryLimit=500, stageLimit=500 }={}) {
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
    version: RESULT_VERSION,
    sheets: {
      '新币发现': discoveryRows(db, lookup, Math.max(50, Math.min(900, Number(discoveryLimit) || 500))),
      'Canary跟踪': canaryRows(db, lookup),
      '阶段升级记录': stageRows(db, lookup, Math.max(50, Math.min(900, Number(stageLimit) || 500))),
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

export function rowsToCsv(rows=[]) {
  const encode = value => {
    if (value == null) return '';
    const s = String(value).replace(/\r?\n/g, ' ');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return (Array.isArray(rows) ? rows : []).map(row => row.map(encode).join(',')).join('\n') + '\n';
}