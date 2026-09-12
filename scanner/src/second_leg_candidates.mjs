import { readFile } from 'node:fs/promises';
import { getDatabase } from './db.mjs';
import { ensurePriceMilestoneSchema } from './price_milestones.mjs';
import { ensureAthSchema } from './ath_metrics.mjs';
import { ensureStageSchema } from './stages.mjs';
import { ensureOpportunitySchema } from './opportunity_repository.mjs';

const DEFAULTS = {
  minAgeMs: Math.max(5 * 60_000, Number(process.env.SECOND_LEG_CANDIDATE_MIN_AGE_MS || 30 * 60_000)),
  minPeakMultiple: Math.max(1, Number(process.env.SECOND_LEG_CANDIDATE_MIN_PEAK_MULTIPLE || 1.30)),
  minLiquidity: Math.max(0, Number(process.env.SECOND_LEG_CANDIDATE_MIN_LIQUIDITY || 10_000)),
  maxScanCandidates: Math.max(6, Math.min(100, Number(process.env.SECOND_LEG_MAX_CANDIDATES || 40))),
};

const WRITE_CHUNK_SIZE = Math.max(10, Math.min(100, Number(process.env.SECOND_LEG_CANDIDATE_WRITE_CHUNK || 25)));
const BUSY_RETRIES = Math.max(1, Math.min(8, Number(process.env.SECOND_LEG_CANDIDATE_BUSY_RETRIES || 4)));
const BUSY_RETRY_MS = Math.max(50, Number(process.env.SECOND_LEG_CANDIDATE_BUSY_RETRY_MS || 250));
let schemaReady = false;

const text = v => v == null ? '' : String(v).trim();
const lower = v => text(v).toLowerCase();
const num = v => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const validAddress = v => /^0x[a-f0-9]{40}$/.test(lower(v));
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isBusy = err => /SQLITE_(BUSY|LOCKED)|database is locked/i.test(text(err?.code || err?.message || err));

async function withBusyRetry(fn) {
  let last = null;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try { return fn(); }
    catch (err) {
      last = err;
      if (!isBusy(err) || attempt >= BUSY_RETRIES) throw err;
      await sleep(BUSY_RETRY_MS * (attempt + 1));
    }
  }
  throw last;
}

export function ensureSecondLegCandidateSchema() {
  if (schemaReady) return getSecondLegCandidateHealth();
  ensurePriceMilestoneSchema();
  ensureAthSchema();
  ensureStageSchema();
  ensureOpportunitySchema();
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS second_leg_candidates (
      token_address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'AUTO_CANARY',
      source_stage TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT,
      canary_at TEXT,
      candidate_since TEXT NOT NULL,
      last_seen_at TEXT,
      ath_price_usd REAL,
      ath_price_at TEXT,
      preferred_pair TEXT NOT NULL DEFAULT '',
      current_price_usd REAL,
      current_liquidity_usd REAL,
      peak_multiple REAL,
      risk_gate TEXT NOT NULL DEFAULT 'CAUTION',
      risk_confidence REAL NOT NULL DEFAULT 0,
      buy_blocked INTEGER NOT NULL DEFAULT 0,
      hard_fail_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'WARMUP',
      status_reason TEXT NOT NULL DEFAULT '',
      manual_override INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_second_leg_candidates_status
      ON second_leg_candidates(enabled, status, manual_override DESC, risk_gate, peak_multiple DESC, current_liquidity_usd DESC);
    CREATE INDEX IF NOT EXISTS idx_second_leg_candidates_updated
      ON second_leg_candidates(updated_at DESC);
  `);
  schemaReady = true;
  return getSecondLegCandidateHealth();
}

export function deriveCandidateStatus(row = {}, cfg = DEFAULTS, atMs = Date.now()) {
  const riskGate = text(row.riskGate || row.risk_gate || 'CAUTION').toUpperCase();
  const buyBlocked = Boolean(Number(row.buyBlocked ?? row.buy_blocked ?? 0));
  const hardFailCount = Number(row.hardFailCount ?? row.hard_fail_count ?? 0) || 0;
  const sourceStage = text(row.sourceStage || row.source_stage || row.monitor_stage).toUpperCase();
  const manual = Boolean(Number(row.manualOverride ?? row.manual_override ?? 0));
  const canaryAt = text(row.canaryAt || row.canary_at);
  const canaryMs = new Date(canaryAt || 0).getTime();
  const ageMs = Number.isFinite(canaryMs) && canaryMs > 0 ? Math.max(0, atMs - canaryMs) : Infinity;
  const ath = num(row.athPriceUsd ?? row.ath_price_usd);
  const peak = num(row.peakMultiple ?? row.peak_multiple) || 0;
  const liquidity = num(row.currentLiquidityUsd ?? row.current_liquidity_usd) || 0;

  if (sourceStage === 'REJECTED' || buyBlocked || hardFailCount > 0 || riskGate === 'BLOCK') {
    return { status: 'BLOCKED', reason: sourceStage === 'REJECTED' ? 'source_rejected' : buyBlocked ? 'buy_blocked' : hardFailCount > 0 ? 'hard_risk_fail' : 'risk_gate_block' };
  }
  if (manual) return { status: 'ACTIVE', reason: 'manual_override' };
  if (!canaryAt) return { status: 'WARMUP', reason: 'canary_history_missing' };
  if (ageMs < cfg.minAgeMs) return { status: 'WARMUP', reason: 'canary_age_warmup' };
  if (!(ath > 0)) return { status: 'WARMUP', reason: 'ath_missing' };
  if (peak < cfg.minPeakMultiple) return { status: 'WATCH', reason: 'first_leg_not_strong_enough' };
  if (liquidity < cfg.minLiquidity) return { status: 'WATCH', reason: 'liquidity_below_candidate_floor' };
  return { status: 'ACTIVE', reason: 'auto_first_leg_complete' };
}

function bestKnownPair(db, token) {
  const canonical = db.prepare(`
    SELECT pool_key FROM market_ticks
    WHERE token_address=? AND lower(source)<>'pons-curve' AND pool_key<>'' AND liquidity_usd IS NOT NULL
    GROUP BY pool_key
    ORDER BY MAX(liquidity_usd) DESC, pool_key ASC LIMIT 1
  `).get(token)?.pool_key;
  if (text(canonical)) return lower(canonical);
  const tick = db.prepare(`
    SELECT pool_key FROM market_ticks
    WHERE token_address=? AND pool_key<>''
    ORDER BY tick_at DESC, id DESC LIMIT 1
  `).get(token)?.pool_key;
  if (text(tick)) return lower(tick);
  const snap = db.prepare(`
    SELECT pair_address FROM snapshots
    WHERE token_address=? AND pair_address<>''
    ORDER BY snapshot_at DESC, id DESC LIMIT 1
  `).get(token)?.pair_address;
  if (text(snap)) return lower(snap);
  const pool = db.prepare(`
    SELECT CASE WHEN pool_address<>'' THEN pool_address ELSE pool_key END AS pair_key
    FROM pools WHERE token_address=?
    ORDER BY discovered_at ASC, id ASC LIMIT 1
  `).get(token)?.pair_key;
  return lower(pool);
}

function autoSourceRows(db) {
  return db.prepare(`
    SELECT
      t.token_address,
      t.symbol,
      COALESCE(t.monitor_stage, t.stage, '') AS source_stage,
      t.first_seen_at,
      t.canary_at,
      t.last_seen_at,
      t.qualified_ath_price_usd AS ath_price_usd,
      t.qualified_ath_at AS ath_price_at,
      t.current_price_usd,
      t.current_liquidity_usd,
      MAX(COALESCE(t.qualified_max_multiple_canary,0), COALESCE(t.qualified_max_multiple_discovery,0)) AS peak_multiple,
      COALESCE(o.risk_gate,'CAUTION') AS risk_gate,
      COALESCE(o.risk_confidence,0) AS risk_confidence,
      COALESCE(o.buy_blocked,0) AS buy_blocked,
      COALESCE(o.hard_fail_count,0) AS hard_fail_count
    FROM tokens t
    LEFT JOIN opportunity_pool o ON o.token_address=t.token_address
    WHERE t.canary_at IS NOT NULL
  `).all();
}

function normalizeManualRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(x => validAddress(x?.address)).map(x => ({
    token_address: lower(x.address),
    symbol: text(x.symbol),
    source_stage: 'MANUAL',
    first_seen_at: null,
    canary_at: null,
    last_seen_at: null,
    ath_price_usd: num(x.athPriceUsd),
    ath_price_at: null,
    preferred_pair: lower(x.preferredPair),
    current_price_usd: null,
    current_liquidity_usd: null,
    peak_multiple: null,
    risk_gate: text(x.fallbackRiskGate || 'CAUTION').toUpperCase(),
    risk_confidence: 0,
    buy_blocked: text(x.fallbackRiskGate).toUpperCase() === 'BLOCK' ? 1 : 0,
    hard_fail_count: 0,
    manual_override: 1,
    enabled: x.enabled === false ? 0 : 1,
  }));
}

async function readManualOverrides(path) {
  if (!path) return [];
  try { return normalizeManualRows(JSON.parse(await readFile(path, 'utf8'))); }
  catch (e) {
    console.error('[second-leg candidates manual overrides]', text(e?.message || e));
    return [];
  }
}

function upsertCandidate(db, row, source, cfg, now) {
  const token = lower(row.token_address);
  if (!validAddress(token)) return false;
  const existing = db.prepare('SELECT * FROM second_leg_candidates WHERE token_address=?').get(token);
  const merged = {
    token_address: token,
    symbol: text(row.symbol) || text(existing?.symbol),
    source,
    source_stage: text(row.source_stage) || text(existing?.source_stage),
    first_seen_at: row.first_seen_at || existing?.first_seen_at || null,
    canary_at: row.canary_at || existing?.canary_at || null,
    candidate_since: existing?.candidate_since || row.canary_at || now,
    last_seen_at: row.last_seen_at || existing?.last_seen_at || null,
    ath_price_usd: num(row.ath_price_usd) ?? num(existing?.ath_price_usd),
    ath_price_at: row.ath_price_at || existing?.ath_price_at || null,
    preferred_pair: lower(row.preferred_pair) || lower(existing?.preferred_pair) || bestKnownPair(db, token),
    current_price_usd: num(row.current_price_usd) ?? num(existing?.current_price_usd),
    current_liquidity_usd: num(row.current_liquidity_usd) ?? num(existing?.current_liquidity_usd),
    peak_multiple: num(row.peak_multiple) ?? num(existing?.peak_multiple),
    risk_gate: text(row.risk_gate || existing?.risk_gate || 'CAUTION').toUpperCase(),
    risk_confidence: num(row.risk_confidence) ?? num(existing?.risk_confidence) ?? 0,
    buy_blocked: Number(row.buy_blocked ?? existing?.buy_blocked ?? 0) ? 1 : 0,
    hard_fail_count: Number(row.hard_fail_count ?? existing?.hard_fail_count ?? 0) || 0,
    manual_override: Number(row.manual_override ?? 0) ? 1 : 0,
    enabled: Number(row.enabled ?? existing?.enabled ?? 1) ? 1 : 0,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  const status = deriveCandidateStatus(merged, cfg);
  merged.status = merged.enabled ? status.status : 'DISABLED';
  merged.status_reason = merged.enabled ? status.reason : 'manual_disabled';
  db.prepare(`
    INSERT INTO second_leg_candidates (
      token_address,symbol,source,source_stage,first_seen_at,canary_at,candidate_since,last_seen_at,
      ath_price_usd,ath_price_at,preferred_pair,current_price_usd,current_liquidity_usd,peak_multiple,
      risk_gate,risk_confidence,buy_blocked,hard_fail_count,status,status_reason,manual_override,enabled,created_at,updated_at
    ) VALUES (
      @token_address,@symbol,@source,@source_stage,@first_seen_at,@canary_at,@candidate_since,@last_seen_at,
      @ath_price_usd,@ath_price_at,@preferred_pair,@current_price_usd,@current_liquidity_usd,@peak_multiple,
      @risk_gate,@risk_confidence,@buy_blocked,@hard_fail_count,@status,@status_reason,@manual_override,@enabled,@created_at,@updated_at
    ) ON CONFLICT(token_address) DO UPDATE SET
      symbol=excluded.symbol,source=excluded.source,source_stage=excluded.source_stage,
      first_seen_at=COALESCE(excluded.first_seen_at,second_leg_candidates.first_seen_at),
      canary_at=COALESCE(excluded.canary_at,second_leg_candidates.canary_at),
      last_seen_at=COALESCE(excluded.last_seen_at,second_leg_candidates.last_seen_at),
      ath_price_usd=COALESCE(excluded.ath_price_usd,second_leg_candidates.ath_price_usd),
      ath_price_at=COALESCE(excluded.ath_price_at,second_leg_candidates.ath_price_at),
      preferred_pair=CASE WHEN excluded.preferred_pair<>'' THEN excluded.preferred_pair ELSE second_leg_candidates.preferred_pair END,
      current_price_usd=COALESCE(excluded.current_price_usd,second_leg_candidates.current_price_usd),
      current_liquidity_usd=COALESCE(excluded.current_liquidity_usd,second_leg_candidates.current_liquidity_usd),
      peak_multiple=COALESCE(excluded.peak_multiple,second_leg_candidates.peak_multiple),
      risk_gate=excluded.risk_gate,risk_confidence=excluded.risk_confidence,
      buy_blocked=excluded.buy_blocked,hard_fail_count=excluded.hard_fail_count,
      status=excluded.status,status_reason=excluded.status_reason,
      manual_override=excluded.manual_override,enabled=excluded.enabled,updated_at=excluded.updated_at
  `).run(merged);
  return true;
}

export async function syncSecondLegCandidates({ manualPath = '', cfg = DEFAULTS } = {}) {
  ensureSecondLegCandidateSchema();
  const db = getDatabase();
  const now = nowIso();
  const automatic = autoSourceRows(db);
  const manual = await readManualOverrides(manualPath);
  const manualSet = new Set(manual.map(x => x.token_address));
  let autoUpserts = 0;
  let manualUpserts = 0;

  await withBusyRetry(() => db.transaction(() => {
    db.prepare("UPDATE second_leg_candidates SET manual_override=0 WHERE manual_override<>0").run();
  })());

  for (let offset = 0; offset < automatic.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = automatic.slice(offset, offset + WRITE_CHUNK_SIZE);
    const changed = await withBusyRetry(() => db.transaction(() => {
      let count = 0;
      for (const row of chunk) {
        const token = lower(row.token_address);
        const existing = db.prepare('SELECT manual_override, enabled FROM second_leg_candidates WHERE token_address=?').get(token);
        const manualStillPresent = manualSet.has(token);
        count += upsertCandidate(db, { ...row, manual_override: manualStillPresent ? 1 : 0, enabled: existing?.enabled ?? 1 }, manualStillPresent ? 'AUTO_CANARY+MANUAL' : 'AUTO_CANARY', cfg, now) ? 1 : 0;
      }
      return count;
    })());
    autoUpserts += changed;
    if (offset + WRITE_CHUNK_SIZE < automatic.length) await sleep(25);
  }

  if (manual.length) {
    manualUpserts = await withBusyRetry(() => db.transaction(() => {
      let count = 0;
      for (const row of manual) {
        const tokenRow = db.prepare(`SELECT symbol,first_seen_at,canary_at,last_seen_at,qualified_ath_price_usd AS ath_price_usd,qualified_ath_at AS ath_price_at,current_price_usd,current_liquidity_usd,MAX(COALESCE(qualified_max_multiple_canary,0),COALESCE(qualified_max_multiple_discovery,0)) peak_multiple,COALESCE(monitor_stage,stage,'') source_stage FROM tokens WHERE token_address=?`).get(row.token_address) || {};
        const op = db.prepare('SELECT risk_gate,risk_confidence,buy_blocked,hard_fail_count FROM opportunity_pool WHERE token_address=?').get(row.token_address) || {};
        const merged = {
          ...tokenRow,
          ...row,
          symbol: row.symbol || tokenRow.symbol || '',
          ath_price_usd: row.ath_price_usd ?? tokenRow.ath_price_usd ?? null,
          preferred_pair: row.preferred_pair || bestKnownPair(db, row.token_address),
          risk_gate: op.risk_gate || row.risk_gate || 'CAUTION',
          risk_confidence: op.risk_confidence ?? 0,
          buy_blocked: op.buy_blocked ?? row.buy_blocked ?? 0,
          hard_fail_count: op.hard_fail_count ?? 0,
          manual_override: 1,
        };
        count += upsertCandidate(db, merged, tokenRow.canary_at ? 'AUTO_CANARY+MANUAL' : 'MANUAL', cfg, now) ? 1 : 0;
      }
      return count;
    })());
  }

  return { autoUpserts, manualUpserts, writeChunkSize: WRITE_CHUNK_SIZE, ...getSecondLegCandidateHealth() };
}

export function getSecondLegCandidateWatchlist(limit = DEFAULTS.maxScanCandidates) {
  ensureSecondLegCandidateSchema();
  const n = Math.max(1, Math.min(100, Number(limit || DEFAULTS.maxScanCandidates)));
  const rows = getDatabase().prepare(`
    SELECT * FROM second_leg_candidates
    WHERE enabled=1 AND status='ACTIVE' AND buy_blocked=0 AND risk_gate<>'BLOCK'
    ORDER BY manual_override DESC,
      CASE risk_gate WHEN 'CLEAR' THEN 0 ELSE 1 END ASC,
      COALESCE(peak_multiple,0) DESC,
      COALESCE(current_liquidity_usd,0) DESC,
      candidate_since ASC
    LIMIT ?
  `).all(n);
  return rows.map(r => ({
    symbol: r.symbol || '',
    address: lower(r.token_address),
    preferredPair: lower(r.preferred_pair),
    athPriceUsd: num(r.ath_price_usd),
    fallbackRiskGate: text(r.risk_gate || 'CAUTION').toUpperCase(),
    candidateSource: r.source,
    candidateStatus: r.status,
    peakMultiple: num(r.peak_multiple),
    manualOverride: Boolean(r.manual_override),
  }));
}

export function getSecondLegCandidateHealth() {
  const db = getDatabase();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='second_leg_candidates'").get();
  if (!exists) return { total: 0, active: 0, blocked: 0, watch: 0, warmup: 0, manual: 0, auto: 0 };
  const r = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN enabled=1 AND status='ACTIVE' THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN status='BLOCKED' THEN 1 ELSE 0 END) blocked,
      SUM(CASE WHEN status='WATCH' THEN 1 ELSE 0 END) watch,
      SUM(CASE WHEN status='WARMUP' THEN 1 ELSE 0 END) warmup,
      SUM(CASE WHEN manual_override=1 THEN 1 ELSE 0 END) manual,
      SUM(CASE WHEN source LIKE 'AUTO_CANARY%' THEN 1 ELSE 0 END) auto,
      MAX(updated_at) updated_at
    FROM second_leg_candidates
  `).get() || {};
  return {
    total: Number(r.total || 0), active: Number(r.active || 0), blocked: Number(r.blocked || 0),
    watch: Number(r.watch || 0), warmup: Number(r.warmup || 0), manual: Number(r.manual || 0),
    auto: Number(r.auto || 0), updatedAt: r.updated_at || null,
  };
}

export { DEFAULTS as SECOND_LEG_CANDIDATE_DEFAULTS };
