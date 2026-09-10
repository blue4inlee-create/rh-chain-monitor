import { getDatabase } from './db.mjs';
import { ensureRiskSchema } from './risk.mjs';

export const SCORE_VERSION = 'score-v1.0';

function text(v) {
  return v == null ? '' : String(v).trim();
}
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}
function safeJson(v) {
  try { return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x); }
  catch { return '{}'; }
}

export function ensureScoreSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      score_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      snapshot_type TEXT NOT NULL DEFAULT '',
      discovery_score REAL NOT NULL DEFAULT 0,
      momentum_score REAL NOT NULL DEFAULT 0,
      liquidity_score REAL NOT NULL DEFAULT 0,
      flow_score REAL NOT NULL DEFAULT 0,
      risk_score REAL NOT NULL DEFAULT 0,
      alpha_score REAL NOT NULL DEFAULT 0,
      final_score REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      score_version TEXT NOT NULL,
      reason_json TEXT NOT NULL DEFAULT '{}',
      scored_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_token ON scores(token_address, scored_at);
    CREATE INDEX IF NOT EXISTS idx_scores_final ON scores(final_score DESC, scored_at DESC);
  `);
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < 6) db.pragma('user_version = 6');
}

function discoveryScore({ riskRows, pons, snapshot }) {
  const metaPass = riskRows.some(r => r.check_name === 'CONTRACT_METADATA' && r.status === 'PASS');
  const launchPass = riskRows.some(r => r.check_name === 'LAUNCH_SOURCE' && r.status === 'PASS');
  let score = 0;
  if (pons?.isPons || launchPass) score += 12;
  else if (/v3|v4|uniswap/i.test(`${snapshot?.dex || ''} ${snapshot?.source_status || ''}`)) score += 8;
  else score += 4;
  if (metaPass) score += 8;
  return clamp(score, 0, 20);
}

function momentumScore(snapshot) {
  const change = num(snapshot?.price_change_pct);
  const price = num(snapshot?.price_usd);
  if (change == null) return price != null ? 5 : 0;
  if (change >= 50) return 25;
  if (change >= 20) return 22;
  if (change >= 10) return 18;
  if (change >= 3) return 14;
  if (change > 0) return 10;
  if (change >= -10) return 6;
  if (change >= -25) return 3;
  return 1;
}

function liquidityScore(snapshot, pons) {
  const lp = num(snapshot?.liquidity_usd);
  if (lp != null) {
    if (lp >= 50000) return 20;
    if (lp >= 20000) return 18;
    if (lp >= 10000) return 15;
    if (lp >= 5000) return 12;
    if (lp >= 2000) return 8;
    if (lp > 0) return 4;
    return 0;
  }
  const reserve = num(pons?.reserveUsd);
  if (reserve != null) {
    if (reserve >= 10000) return 18;
    if (reserve >= 5000) return 15;
    if (reserve >= 2000) return 12;
    if (reserve >= 500) return 8;
    if (reserve > 0) return 5;
  }
  if (pons?.isPons && Number(pons?.phase) === 0) return 4;
  return 0;
}

function flowScore(snapshot) {
  const buys = num(snapshot?.buy_count);
  const sells = num(snapshot?.sell_count);
  const total = buys != null && sells != null ? buys + sells : null;
  if (total == null) {
    const change = num(snapshot?.price_change_pct);
    return change != null && change > 5 ? 6 : 2;
  }
  const ratio = (buys + 1) / (sells + 1);
  if (total >= 50 && ratio >= 2) return 20;
  if (total >= 20 && ratio >= 1.5) return 17;
  if (total >= 10 && ratio >= 1.25) return 14;
  if (total >= 5 && buys > sells) return 10;
  if (buys > sells) return 7;
  if (total > 0) return 4;
  return 1;
}

function riskScore(riskRows) {
  let score = 15;
  let unknown = 0;
  for (const r of riskRows) {
    const sev = Number(r.severity || 0);
    if (r.status === 'FAIL') score -= Math.max(6, sev * 4);
    else if (r.status === 'WARN') score -= Math.max(1, sev * 2);
    else if (r.status === 'UNKNOWN') unknown++;
  }
  score -= Math.min(5, unknown * 0.5);
  return clamp(score, 0, 15);
}

function confidenceScore(snapshot, riskRows, pons) {
  let c = 25;
  if (pons?.isPons || text(snapshot?.dex)) c += 15;
  if (riskRows.some(r => r.check_name === 'CONTRACT_METADATA' && r.status === 'PASS')) c += 15;
  if (num(snapshot?.price_usd) != null) c += 15;
  if (num(snapshot?.liquidity_usd) != null || num(pons?.reserveUsd) != null) c += 10;
  if (num(snapshot?.buy_count) != null && num(snapshot?.sell_count) != null) c += 10;
  if (num(snapshot?.holder_count) != null) c += 10;
  return clamp(c, 0, 100);
}

export function calculateScore({ snapshot = {}, pons = {} } = {}) {
  ensureRiskSchema();
  ensureScoreSchema();
  const db = getDatabase();
  const token = text(snapshot.token_address).toLowerCase();
  const pool = text(snapshot.pool_key).toLowerCase();
  const type = text(snapshot.snapshot_type);
  const riskRows = db.prepare(`
    SELECT check_name, status, severity, value, details
    FROM risk_checks
    WHERE token_address=? AND pool_key=? AND snapshot_type=?
    ORDER BY check_name
  `).all(token, pool, type);

  const discovery = discoveryScore({ riskRows, pons, snapshot });
  const momentum = momentumScore(snapshot);
  const liquidity = liquidityScore(snapshot, pons);
  const flow = flowScore(snapshot);
  const risk = riskScore(riskRows);
  const alpha = [discovery >= 16, momentum >= 14, liquidity >= 12, flow >= 12, risk >= 11]
    .reduce((n, yes) => n + (yes ? 2 : 0), 0);
  const final = clamp(discovery + momentum + liquidity + flow + risk + alpha, 0, 100);
  const confidence = confidenceScore(snapshot, riskRows, pons);

  return {
    token_address: token,
    pool_key: pool,
    snapshot_type: type,
    discovery_score: discovery,
    momentum_score: momentum,
    liquidity_score: liquidity,
    flow_score: flow,
    risk_score: risk,
    alpha_score: alpha,
    final_score: final,
    confidence,
    score_version: SCORE_VERSION,
    reason: {
      priceUsd: num(snapshot.price_usd),
      marketCap: num(snapshot.market_cap),
      liquidityUsd: num(snapshot.liquidity_usd),
      priceChangePct: num(snapshot.price_change_pct),
      buys: num(snapshot.buy_count),
      sells: num(snapshot.sell_count),
      ponsReserveUsd: num(pons?.reserveUsd),
      ponsPhase: pons?.phase ?? null,
      riskCounts: riskRows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    },
  };
}

export function saveScore(context = {}) {
  const score = calculateScore(context);
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

export function getScoreHealth() {
  ensureScoreSchema();
  const db = getDatabase();
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM scores').get()?.n || 0);
  const latest = db.prepare('SELECT MAX(scored_at) AS ts FROM scores').get()?.ts || null;
  const high = Number(db.prepare('SELECT COUNT(*) AS n FROM scores WHERE final_score >= 70').get()?.n || 0);
  return { scores: total, highScores: high, lastScoreAt: latest, scoreVersion: SCORE_VERSION };
}
