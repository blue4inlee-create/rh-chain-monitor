import { getDatabase } from './db.mjs';
import { refreshShadowStages } from './stage_ladder_shadow.mjs';

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

export function ensureScoreV2Schema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scores_v2_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      score_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      snapshot_type TEXT NOT NULL DEFAULT 'M30',
      structural_score REAL NOT NULL DEFAULT 0,
      price_quality_score REAL NOT NULL DEFAULT 0,
      reserve_level_score REAL NOT NULL DEFAULT 0,
      reserve_velocity_score REAL NOT NULL DEFAULT 0,
      progress_velocity_score REAL NOT NULL DEFAULT 0,
      alpha_bonus REAL NOT NULL DEFAULT 0,
      penalty_score REAL NOT NULL DEFAULT 0,
      final_score REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      score_version TEXT NOT NULL,
      reason_json TEXT NOT NULL DEFAULT '{}',
      scored_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_v2_token ON scores_v2_shadow(token_address, scored_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scores_v2_final ON scores_v2_shadow(final_score DESC, scored_at DESC);
  `);
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
  ensureScoreV2Schema();
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
    structural_score: structural,
    price_quality_score: priceQuality,
    reserve_level_score: reserveLevel,
    reserve_velocity_score: reserveVelocity,
    progress_velocity_score: progressVelocity,
    alpha_bonus: alphaBonus,
    penalty_score: penalty,
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
    INSERT INTO scores_v2_shadow (
      score_key, token_address, pool_key, snapshot_type,
      structural_score, price_quality_score, reserve_level_score,
      reserve_velocity_score, progress_velocity_score, alpha_bonus,
      penalty_score, final_score, confidence, score_version, reason_json, scored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(score_key) DO UPDATE SET
      structural_score=excluded.structural_score,
      price_quality_score=excluded.price_quality_score,
      reserve_level_score=excluded.reserve_level_score,
      reserve_velocity_score=excluded.reserve_velocity_score,
      progress_velocity_score=excluded.progress_velocity_score,
      alpha_bonus=excluded.alpha_bonus,
      penalty_score=excluded.penalty_score,
      final_score=excluded.final_score,
      confidence=excluded.confidence,
      reason_json=excluded.reason_json,
      scored_at=excluded.scored_at
  `).run(
    key, score.token_address, score.pool_key, score.snapshot_type,
    score.structural_score, score.price_quality_score, score.reserve_level_score,
    score.reserve_velocity_score, score.progress_velocity_score, score.alpha_bonus,
    score.penalty_score, score.final_score, score.confidence,
    score.score_version, safeJson(score.reason), scoredAt,
  );
  return { ...score, scored_at: scoredAt };
}

export function backfillM30ScoresV2(limit=500) {
  ensureScoreV2Schema();
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT m.token_address
    FROM marlin_30s m
    WHERE EXISTS (
      SELECT 1 FROM scores s
      WHERE s.token_address=m.token_address
        AND s.snapshot_type='INITIAL'
        AND s.score_version='score-v1.0'
    )
      AND NOT EXISTS (
        SELECT 1 FROM scores_v2_shadow v WHERE v.token_address=m.token_address
      )
    ORDER BY m.observed_at ASC
    LIMIT ?
  `).all(Math.max(1, Math.min(2000, Number(limit) || 500)));
  let saved = 0;
  for (const row of rows) {
    if (saveM30ScoreV2(row.token_address)) saved++;
  }
  let ladder = null;
  try {
    ladder = refreshShadowStages({ limit: 1000 });
  } catch (err) {
    ladder = { error: String(err?.message || err) };
  }
  return { candidates: rows.length, saved, ladder, ...getScoreV2Health() };
}

export function getScoreV2Health() {
  ensureScoreV2Schema();
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COUNT(*) AS n, AVG(final_score) AS avg_score, MAX(final_score) AS max_score, MAX(scored_at) AS latest
    FROM scores_v2_shadow
  `).get() || {};
  return {
    scoresV2: Number(row.n || 0),
    avgScoreV2: num(row.avg_score),
    maxScoreV2: num(row.max_score),
    latestScoreV2At: row.latest || null,
    version: SCORE_V2_VERSION,
  };
}
