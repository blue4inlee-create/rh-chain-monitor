import { getDatabase } from './db.mjs';

export const SCORE_V2_VERSION = 'score-v2.0-shadow';

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, lo=0, hi=100) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return '{}'; }
}

function reserveLevelScore(reserve) {
  const r = num(reserve);
  if (r == null) return 0;
  if (r < 100) return 2;
  if (r < 300) return 5;
  if (r < 500) return 8;
  if (r < 1000) return 12;
  if (r < 1800) return 16;
  if (r < 3000) return 18;
  if (r <= 5000) return 16;
  return 10;
}

function reserveVelocityScore(changePct) {
  const c = num(changePct);
  if (c == null) return 0;
  if (c <= -10) return 0;
  if (c < 0) return 3;
  if (c < 5) return 6;
  if (c < 15) return 12;
  if (c < 30) return 18;
  if (c < 60) return 22;
  return 25;
}

function progressVelocityScore(delta) {
  const d = num(delta);
  if (d == null) return 0;
  if (d < 0) return 0;
  if (d < 0.25) return 4;
  if (d < 1) return 8;
  if (d < 3) return 13;
  if (d < 6) return 17;
  return 20;
}

function priceQualityScore(changePct) {
  const c = num(changePct);
  if (c == null) return 0;
  if (c < -10) return 0;
  if (c < -3) return 3;
  if (c < 1) return 7;
  if (c < 5) return 10;
  if (c < 15) return 13;
  if (c < 35) return 15;
  if (c < 60) return 10;
  return 5;
}

function marketCapPenalty(mc) {
  const m = num(mc);
  if (m == null) return 0;
  if (m >= 20000) return 18;
  if (m >= 15000) return 12;
  if (m >= 12000) return 8;
  if (m >= 10000) return 5;
  return 0;
}

function structuralScore(v1) {
  const discovery = num(v1?.discovery_score) || 0;
  const risk = num(v1?.risk_score) || 0;
  return clamp(discovery * 0.65 + risk * 0.45, 0, 20);
}

export function calculateM30ScoreV2(tokenAddress) {
  const db = getDatabase();
  const token = String(tokenAddress || '').trim().toLowerCase();
  const m30 = db.prepare('SELECT * FROM marlin_30s WHERE token_address=?').get(token);
  if (!m30) return null;
  const v1 = db.prepare(`
    SELECT * FROM scores
    WHERE token_address=? AND snapshot_type='INITIAL' AND score_version='score-v1.0'
    ORDER BY scored_at DESC, id DESC LIMIT 1
  `).get(token);
  if (!v1) return null;

  const structural = structuralScore(v1);
  const reserveLevel = reserveLevelScore(m30.reserve_usd);
  const reserveVelocity = reserveVelocityScore(m30.reserve_change_pct);
  const progressVelocity = progressVelocityScore(m30.curve_progress_delta);
  const priceQuality = priceQualityScore(m30.price_change_pct);

  let penalty = marketCapPenalty(m30.market_cap);
  const initialReserve = num(m30.initial_reserve_usd);
  const reserveChange = num(m30.reserve_change_pct);
  const initialProgress = num(m30.initial_curve_progress_pct);
  const progressDelta = num(m30.curve_progress_delta);
  const priceChange = num(m30.price_change_pct);

  const exhaustion = (initialReserve != null && initialReserve >= 500 && reserveChange != null && reserveChange <= 0)
    || (initialProgress != null && initialProgress >= 5 && progressDelta != null && progressDelta <= 0 && (priceChange ?? 0) <= 1);
  if (exhaustion) penalty += 12;

  let alphaBonus = 0;
  const sustainedAcceleration = reserveChange != null && reserveChange >= 20
    && progressDelta != null && progressDelta >= 1
    && priceChange != null && priceChange >= 2 && priceChange <= 35;
  if (sustainedAcceleration) alphaBonus += 8;
  if (Number(m30.graduated || 0) === 1) alphaBonus += 4;

  const final = clamp(
    structural + reserveLevel + reserveVelocity + progressVelocity + priceQuality + alphaBonus - penalty,
    0,
    100,
  );
  const completeness = [m30.price_usd, m30.reserve_usd, m30.curve_progress_pct, m30.initial_price_usd, m30.initial_reserve_usd]
    .filter(v => num(v) != null).length;
  const confidence = clamp(45 + completeness * 9, 0, 90);

  return {
    token_address: token,
    pool_key: String(v1.pool_key || '').toLowerCase(),
    snapshot_type: 'M30',
    discovery_score: structural,
    momentum_score: priceQuality + progressVelocity,
    liquidity_score: reserveLevel,
    flow_score: reserveVelocity,
    risk_score: clamp(15 - penalty, 0, 15),
    alpha_score: alphaBonus,
    final_score: final,
    confidence,
    score_version: SCORE_V2_VERSION,
    reason: {
      model: 'Pons M30 early-quality shadow',
      ageSec: num(m30.age_sec),
      initialScoreV1: num(v1.final_score),
      marketCap: num(m30.market_cap),
      priceChangePct: priceChange,
      initialReserveUsd: initialReserve,
      reserveUsd: num(m30.reserve_usd),
      reserveChangePct: reserveChange,
      initialCurveProgressPct: initialProgress,
      curveProgressPct: num(m30.curve_progress_pct),
      curveProgressDelta: progressDelta,
      components: { structural, reserveLevel, reserveVelocity, progressVelocity, priceQuality },
      penalty,
      exhaustion,
      alphaBonus,
      sustainedAcceleration,
      graduated: Boolean(m30.graduated),
    },
  };
}

export function saveM30ScoreV2(tokenAddress) {
  const score = calculateM30ScoreV2(tokenAddress);
  if (!score) return null;
  const db = getDatabase();
  const scoredAt = new Date().toISOString();
  const key = `${score.token_address}:${score.pool_key}:${score.snapshot_type}:${score.score_version}`;
  db.prepare(`
    INSERT INTO scores (
      score_key, token_address, pool_key, snapshot_type,
      discovery_score, momentum_score, liquidity_score, flow_score,
      risk_score, alpha_score, final_score, confidence,
      score_version, reason_json, scored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(score_key) DO UPDATE SET
      discovery_score=excluded.discovery_score,
      momentum_score=excluded.momentum_score,
      liquidity_score=excluded.liquidity_score,
      flow_score=excluded.flow_score,
      risk_score=excluded.risk_score,
      alpha_score=excluded.alpha_score,
      final_score=excluded.final_score,
      confidence=excluded.confidence,
      reason_json=excluded.reason_json,
      scored_at=excluded.scored_at
  `).run(
    key, score.token_address, score.pool_key, score.snapshot_type,
    score.discovery_score, score.momentum_score, score.liquidity_score, score.flow_score,
    score.risk_score, score.alpha_score, score.final_score, score.confidence,
    score.score_version, safeJson(score.reason), scoredAt,
  );
  return { ...score, scored_at: scoredAt };
}
