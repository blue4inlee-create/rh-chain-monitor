import { getDatabase } from './db.mjs';
import { ensureRiskSchema } from './risk.mjs';

function text(v) {
  return v == null ? '' : String(v).trim();
}
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeJson(v) {
  try { return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x); }
  catch { return '{}'; }
}
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}

export function ensureStageSchema() {
  const db = getDatabase();
  if (!hasColumn(db, 'tokens', 'monitor_stage')) {
    db.exec("ALTER TABLE tokens ADD COLUMN monitor_stage TEXT NOT NULL DEFAULT 'DISCOVERY'");
  }
  if (!hasColumn(db, 'tokens', 'stage_updated_at')) {
    db.exec('ALTER TABLE tokens ADD COLUMN stage_updated_at TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      from_stage TEXT NOT NULL,
      to_stage TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      reason_json TEXT NOT NULL DEFAULT '{}',
      price_at_change REAL,
      market_cap_at_change REAL,
      score_at_change REAL,
      confidence_at_change REAL,
      score_version TEXT NOT NULL DEFAULT '',
      snapshot_type TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_stage_token ON stage_history(token_address, changed_at);
    CREATE INDEX IF NOT EXISTS idx_stage_to ON stage_history(to_stage, changed_at);
  `);
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < 7) db.pragma('user_version = 7');
}

function loadRisks(db, snapshot) {
  return db.prepare(`
    SELECT check_name, status, severity, value, details
    FROM risk_checks
    WHERE token_address=? AND pool_key=? AND snapshot_type=?
  `).all(
    text(snapshot.token_address).toLowerCase(),
    text(snapshot.pool_key).toLowerCase(),
    text(snapshot.snapshot_type),
  );
}

function hardBlocker(risks) {
  return risks.find(r => r.status === 'FAIL' && ['CREATOR_TAX', 'PONS_PHASE'].includes(r.check_name)) || null;
}

function seriousWarning(risks) {
  return risks.some(r => r.status === 'WARN' && Number(r.severity || 0) >= 2);
}

function metadataConfirmed(risks) {
  return risks.some(r => r.check_name === 'CONTRACT_METADATA' && r.status === 'PASS');
}

function canaryRule({ snapshot, score, pons, risks }) {
  if (!metadataConfirmed(risks) || seriousWarning(risks)) {
    return { qualify: false, rule: 'critical_checks_incomplete_or_warn' };
  }
  const finalScore = num(score?.final_score) || 0;
  const confidence = num(score?.confidence) || 0;
  const type = text(snapshot?.snapshot_type);
  const price = num(snapshot?.price_usd);
  const marketCap = num(snapshot?.market_cap);
  if (price == null || marketCap == null) return { qualify: false, rule: 'price_or_marketcap_missing' };

  if (pons?.isPons) {
    const reserve = num(pons?.reserveUsd) || 0;
    const change = num(snapshot?.price_change_pct);
    if (type === 'INITIAL') {
      const qualify = finalScore >= 52 && confidence >= 70 && reserve >= 500;
      return { qualify, rule: 'pons_initial', reserveUsd: reserve, minScore: 52, minReserveUsd: 500 };
    }
    if (type === '1M') {
      const momentumOk = (change != null && change >= 3) || reserve >= 1000;
      const qualify = finalScore >= 55 && confidence >= 70 && momentumOk;
      return { qualify, rule: 'pons_1m', reserveUsd: reserve, priceChangePct: change, minScore: 55 };
    }
    return { qualify: false, rule: 'pons_snapshot_not_supported' };
  }

  const lp = num(snapshot?.liquidity_usd) || 0;
  const buys = num(snapshot?.buy_count) || 0;
  const sells = num(snapshot?.sell_count) || 0;
  const ratio = (buys + 1) / (sells + 1);
  const qualify = finalScore >= 65 && confidence >= 65 && lp >= 10000 && buys >= 5 && ratio >= 1.3;
  return { qualify, rule: 'direct_pool', liquidityUsd: lp, buys, sells, buySellRatio: ratio, minScore: 65 };
}

function transition(db, { snapshot, score, fromStage, toStage, reason, detail }) {
  const token = text(snapshot.token_address).toLowerCase();
  const pool = text(snapshot.pool_key).toLowerCase();
  const now = new Date().toISOString();
  const key = `${token}:${pool}:${toStage}:${text(score?.score_version) || 'unscored'}`;
  const result = db.prepare(`
    INSERT OR IGNORE INTO stage_history (
      stage_key, token_address, pool_key, from_stage, to_stage,
      reason, reason_json, price_at_change, market_cap_at_change,
      score_at_change, confidence_at_change, score_version,
      snapshot_type, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key, token, pool, fromStage, toStage,
    reason, safeJson(detail), num(snapshot.price_usd), num(snapshot.market_cap),
    num(score?.final_score), num(score?.confidence), text(score?.score_version),
    text(snapshot.snapshot_type), now,
  );
  if (result.changes) {
    db.prepare('UPDATE tokens SET monitor_stage=?, stage_updated_at=?, updated_at=? WHERE token_address=?')
      .run(toStage, now, now, token);
  }
  return { changed: result.changes > 0, fromStage, toStage, reason, changedAt: result.changes ? now : null };
}

export function applyStageDecision({ snapshot = {}, score = {}, pons = {} } = {}) {
  ensureRiskSchema();
  ensureStageSchema();
  const db = getDatabase();
  const token = text(snapshot.token_address).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return { changed: false, stage: 'UNKNOWN', reason: 'invalid_token' };
  const row = db.prepare('SELECT monitor_stage FROM tokens WHERE token_address=?').get(token);
  const current = text(row?.monitor_stage) || 'DISCOVERY';
  const risks = loadRisks(db, snapshot);
  const blocker = hardBlocker(risks);

  if (blocker && current !== 'REJECTED') {
    return transition(db, {
      snapshot, score, fromStage: current, toStage: 'REJECTED',
      reason: `hard_risk:${blocker.check_name}`,
      detail: { blocker, score, snapshotType: snapshot.snapshot_type },
    });
  }

  if (current !== 'DISCOVERY') {
    return { changed: false, stage: current, reason: 'stage_already_set' };
  }

  const rule = canaryRule({ snapshot, score, pons, risks });
  if (!rule.qualify) {
    return { changed: false, stage: current, reason: rule.rule, rule };
  }

  return transition(db, {
    snapshot, score, fromStage: current, toStage: 'CANARY',
    reason: rule.rule,
    detail: {
      rule,
      score: {
        final: score.final_score,
        confidence: score.confidence,
        discovery: score.discovery_score,
        momentum: score.momentum_score,
        liquidity: score.liquidity_score,
        flow: score.flow_score,
        risk: score.risk_score,
        alpha: score.alpha_score,
        version: score.score_version,
      },
      snapshotType: snapshot.snapshot_type,
    },
  });
}

export function getStageHealth() {
  ensureStageSchema();
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT monitor_stage AS stage, COUNT(*) AS n
    FROM tokens GROUP BY monitor_stage
  `).all();
  const counts = Object.fromEntries(rows.map(r => [r.stage || 'DISCOVERY', Number(r.n)]));
  const history = Number(db.prepare('SELECT COUNT(*) AS n FROM stage_history').get()?.n || 0);
  return { stages: counts, stageHistory: history };
}
