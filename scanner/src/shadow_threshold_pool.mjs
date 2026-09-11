import { getDatabase } from './db.mjs';
import { ensureSignalOutcomeSchema, recordOutcomeSample } from './signal_outcomes.mjs';

export const SHADOW_PROFILES = [
  { id: 'S55_C50_L5K', score: 55, confidence: 50, liquidity: 5_000 },
  { id: 'S60_C50_L5K', score: 60, confidence: 50, liquidity: 5_000 },
  { id: 'S65_C50_L5K', score: 65, confidence: 50, liquidity: 5_000 },
  { id: 'S55_C55_L7K5', score: 55, confidence: 55, liquidity: 7_500 },
  { id: 'S60_C55_L7K5', score: 60, confidence: 55, liquidity: 7_500 },
  { id: 'S65_C55_L7K5', score: 65, confidence: 55, liquidity: 7_500 },
  { id: 'S60_C60_L10K', score: 60, confidence: 60, liquidity: 10_000 },
  { id: 'S65_C60_L10K', score: 65, confidence: 60, liquidity: 10_000 },
];

const MAX_OPEN_TOKENS = Math.max(5, Math.min(100, Number(process.env.SHADOW_MAX_OPEN_TOKENS || 40)));
const REARM_MS = Math.max(5 * 60_000, Number(process.env.SHADOW_REARM_MS || 30 * 60_000));

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function parseJson(v, fallback = {}) { try { return v && typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch { return fallback; } }
function nowIso() { return new Date().toISOString(); }

export function ensureShadowThresholdSchema() {
  ensureSignalOutcomeSchema();
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_threshold_state (
      profile TEXT NOT NULL,
      token_address TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      event_key TEXT DEFAULT '',
      cycle_started_at TEXT,
      last_seen_at TEXT,
      last_left_at TEXT,
      promoted_at TEXT,
      last_score REAL,
      last_confidence REAL,
      last_liquidity REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(profile, token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_state_active ON shadow_threshold_state(active, profile, updated_at);
  `);
  return db;
}

function hardRisk(row) {
  const payload = parseJson(row.payload, {});
  const reasons = parseJson(row.risk_reasons, []);
  const flags = Array.isArray(payload.riskFlags) ? payload.riskFlags : [];
  const riskText = [...(Array.isArray(reasons) ? reasons : []), ...flags].join('|');
  const riskPenalty = num(payload.riskPenalty ?? payload.risk_penalty ?? payload?.scoreBreakdown?.riskPenalty);
  return {
    blocked: Number(row.buy_blocked || 0) === 1 || text(row.risk_gate).toUpperCase() === 'BLOCK' || Number(row.hard_fail_count || 0) > 0 ||
      /honeypot|blacklist|mint[_ -]?risk|lp[_ -]?risk|rug|cannot[_ -]?sell|sell[_ -]?(block|fail)/i.test(riskText),
    riskPenalty,
  };
}

function productionEligible(row) {
  const risk = hardRisk(row);
  return text(row.stage).toUpperCase() === 'CANARY' &&
    Number(row.score || 0) >= 70 && Number(row.score_confidence || 0) >= 60 && Number(row.liquidity || 0) >= 10_000 &&
    !risk.blocked && (risk.riskPenalty == null || risk.riskPenalty <= 8);
}

function profileEligible(row, profile) {
  const risk = hardRisk(row);
  return text(row.stage).toUpperCase() === 'CANARY' &&
    Number(row.score || 0) >= profile.score && Number(row.score_confidence || 0) >= profile.confidence && Number(row.liquidity || 0) >= profile.liquidity &&
    !risk.blocked && (risk.riskPenalty == null || risk.riskPenalty <= 8);
}

function seedObservation(db, token, at) {
  const recent = db.prepare(`SELECT tick_at AS at,price_usd,market_cap,liquidity_usd,source FROM market_ticks WHERE token_address=? AND price_usd>0 AND tick_at<=? ORDER BY tick_at DESC LIMIT 1`).get(token, at);
  if (recent && new Date(at).getTime() - new Date(recent.at).getTime() <= 5 * 60_000) return recent;
  const current = db.prepare(`SELECT current_price_at AS at,current_price_usd AS price_usd,current_market_cap AS market_cap,current_liquidity_usd AS liquidity_usd,'tokens-current' AS source FROM tokens WHERE token_address=? AND current_price_usd>0`).get(token);
  if (current && Math.abs(new Date(current.at || at).getTime() - new Date(at).getTime()) <= 10 * 60_000) return current;
  return null;
}

function createShadowOutcome(db, row, profile, triggeredAt) {
  const token = text(row.token_address).toLowerCase();
  const eventType = `SHADOW_${profile.id}`;
  const eventKey = `${token}|${eventType}|${triggeredAt}`;
  const seed = seedObservation(db, token, triggeredAt);
  db.prepare(`INSERT OR IGNORE INTO signal_outcomes (
    event_key,event_type,token_address,symbol,triggered_at,entry_price_usd,entry_market_cap,entry_liquidity,score,confidence,risk_gate,data_quality,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    eventKey,eventType,token,text(row.symbol),triggeredAt,num(seed?.price_usd),num(seed?.market_cap),num(seed?.liquidity_usd) ?? num(row.liquidity),
    num(row.score),num(row.score_confidence),text(row.risk_gate),seed?.price_usd ? 'SEEDED' : 'WAITING_ENTRY',triggeredAt,
  );
  if (seed?.price_usd) recordOutcomeSample({ eventKey, tokenAddress: token, sampleAt: seed.at || triggeredAt, priceUsd: seed.price_usd, marketCap: seed.market_cap, liquidityUsd: seed.liquidity_usd, source: seed.source || 'shadow-seed' });
  return eventKey;
}

function openShadowTokenCount(db) {
  return Number(db.prepare(`SELECT COUNT(DISTINCT token_address) AS n FROM signal_outcomes WHERE event_type LIKE 'SHADOW_%' AND status='OPEN'`).get()?.n || 0);
}

export function syncShadowThresholdPool() {
  const db = ensureShadowThresholdSchema();
  const rows = db.prepare(`SELECT * FROM opportunity_pool WHERE stage='CANARY' AND score>=55 AND score_confidence>=50 AND liquidity>=5000 ORDER BY score DESC, score_confidence DESC, liquidity DESC`).all();
  const byToken = new Map(rows.map(r => [text(r.token_address).toLowerCase(), r]));
  const existing = db.prepare(`SELECT * FROM shadow_threshold_state`).all();
  const stateMap = new Map(existing.map(s => [`${s.profile}|${s.token_address}`, s]));
  const now = nowIso();
  let created = 0, promoted = 0, left = 0;
  let openTokens = openShadowTokenCount(db);

  const upsert = db.prepare(`INSERT INTO shadow_threshold_state
    (profile,token_address,active,event_key,cycle_started_at,last_seen_at,last_left_at,promoted_at,last_score,last_confidence,last_liquidity,updated_at)
    VALUES (@profile,@token_address,@active,@event_key,@cycle_started_at,@last_seen_at,@last_left_at,@promoted_at,@last_score,@last_confidence,@last_liquidity,@updated_at)
    ON CONFLICT(profile,token_address) DO UPDATE SET active=excluded.active,event_key=excluded.event_key,cycle_started_at=excluded.cycle_started_at,last_seen_at=excluded.last_seen_at,last_left_at=excluded.last_left_at,promoted_at=excluded.promoted_at,last_score=excluded.last_score,last_confidence=excluded.last_confidence,last_liquidity=excluded.last_liquidity,updated_at=excluded.updated_at`);

  const activeTokenSet = new Set(existing.filter(s => s.active).map(s => s.token_address));
  for (const row of rows) {
    const token = text(row.token_address).toLowerCase();
    if (!token) continue;
    const isProduction = productionEligible(row);
    for (const profile of SHADOW_PROFILES) {
      const key = `${profile.id}|${token}`;
      const prev = stateMap.get(key);
      const eligible = profileEligible(row, profile);
      if (!eligible) continue;
      if (prev?.active) {
        const promotedAt = prev.promoted_at || (isProduction ? now : null);
        if (!prev.promoted_at && promotedAt) promoted += 1;
        upsert.run({ ...prev, active:1, last_seen_at:now, promoted_at:promotedAt, last_score:row.score, last_confidence:row.score_confidence, last_liquidity:row.liquidity, updated_at:now });
        continue;
      }
      if (isProduction) continue;
      const lastLeft = prev?.last_left_at ? new Date(prev.last_left_at).getTime() : 0;
      if (lastLeft && Date.now() - lastLeft < REARM_MS) continue;
      const newToken = !activeTokenSet.has(token);
      if (newToken && openTokens >= MAX_OPEN_TOKENS) continue;
      const eventKey = createShadowOutcome(db, row, profile, now);
      const state = { profile:profile.id, token_address:token, active:1, event_key:eventKey, cycle_started_at:now, last_seen_at:now, last_left_at:prev?.last_left_at || null, promoted_at:null, last_score:row.score, last_confidence:row.score_confidence, last_liquidity:row.liquidity, updated_at:now };
      upsert.run(state);
      stateMap.set(key, state);
      if (newToken) { activeTokenSet.add(token); openTokens += 1; }
      created += 1;
    }
  }

  for (const prev of existing) {
    if (!prev.active) continue;
    const row = byToken.get(prev.token_address);
    const profile = SHADOW_PROFILES.find(p => p.id === prev.profile);
    if (row && profile && profileEligible(row, profile)) continue;
    upsert.run({ ...prev, active:0, last_left_at:now, updated_at:now });
    left += 1;
  }
  return { created, promoted, left, candidates: rows.length, openTokens };
}

function median(values) {
  const xs = values.map(num).filter(v => v != null).sort((a,b)=>a-b);
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i-1] + xs[i]) / 2;
}
function rate(rows, key) { return rows.length ? rows.filter(r => Number(r[key] || 0) === 1).length / rows.length * 100 : null; }

export function getShadowThresholdRows() {
  const db = ensureShadowThresholdSchema();
  const out = [];
  for (const p of SHADOW_PROFILES) {
    const completed = db.prepare(`SELECT * FROM signal_outcomes WHERE event_type=? AND status='COMPLETE' AND data_quality<>'THIN'`).all(`SHADOW_${p.id}`);
    out.push({ rowType:'PROFILE', profile:p.id, status:completed.length >= 20 ? 'READY' : 'WARMUP', score:p.score, confidence:p.confidence, liquidity:p.liquidity, completedSamples:completed.length, cleanWin30Rate:rate(completed,'clean_win_30'), fail30Rate:rate(completed,'hit_minus30'), median24h:median(completed.map(r=>r.h24_return_pct)), medianMfe:median(completed.map(r=>r.max_runup_pct)), medianMdd:median(completed.map(r=>r.max_drawdown_pct)), reason:completed.length >= 20 ? '已有20+完整Shadow样本，可与生产基线比较' : `等待20个完整样本；当前${completed.length}个` });
  }
  const active = db.prepare(`SELECT s.*,o.symbol,o.score AS entry_score,o.confidence AS entry_confidence,o.entry_liquidity,o.risk_gate,o.status AS outcome_status,o.outcome_label,o.m15_return_pct,o.h1_return_pct,o.h6_return_pct,o.h24_return_pct,o.max_runup_pct,o.max_drawdown_pct FROM shadow_threshold_state s LEFT JOIN signal_outcomes o ON o.event_key=s.event_key WHERE s.active=1 ORDER BY s.last_score DESC,s.last_confidence DESC,s.last_liquidity DESC LIMIT 300`).all();
  for (const r of active) out.push({ rowType:'ACTIVE', profile:r.profile, status:r.promoted_at ? 'PROMOTED' : 'SHADOW', symbol:r.symbol, tokenAddress:r.token_address, score:r.entry_score, confidence:r.entry_confidence, liquidity:r.entry_liquidity, riskGate:r.risk_gate, enteredAt:r.cycle_started_at, m15:r.m15_return_pct, h1:r.h1_return_pct, h6:r.h6_return_pct, h24:r.h24_return_pct, medianMfe:r.max_runup_pct, medianMdd:r.max_drawdown_pct, outcomeStatus:r.outcome_status, outcomeLabel:r.outcome_label, reason:r.promoted_at ? '已升级到生产Early Alpha条件；Shadow成绩继续跟踪24h' : '仅记录，不提醒、不影响生产阈值' });
  return out;
}
