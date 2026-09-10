import { getDatabase } from './db.mjs';

export const SHADOW_LADDER_VERSION = 'stage-ladder-v1.0-shadow';
export const SHADOW_SCORE_VERSION = 'score-v2.0-shadow';

const RANK = {
  NONE: 0,
  CANARY_1: 1,
  CANARY_2: 2,
  EARLY_ALPHA: 3,
  CONFIRMED_ALPHA: 4,
};

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return '{}'; }
}

export function ensureShadowLadderSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_ladder_shadow (
      token_address TEXT PRIMARY KEY,
      shadow_stage TEXT NOT NULL DEFAULT 'NONE',
      stage_rank INTEGER NOT NULL DEFAULT 0,
      score_v2 REAL,
      m30_age_sec REAL,
      discovery_max REAL,
      current_multiple REAL,
      token_age_min REAL,
      production_stage TEXT NOT NULL DEFAULT '',
      hard_fail INTEGER NOT NULL DEFAULT 0,
      reason_json TEXT NOT NULL DEFAULT '{}',
      ladder_version TEXT NOT NULL DEFAULT '',
      first_qualified_at TEXT,
      stage_updated_at TEXT,
      evaluated_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE TABLE IF NOT EXISTS stage_ladder_shadow_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      from_stage TEXT NOT NULL,
      to_stage TEXT NOT NULL,
      score_v2 REAL,
      m30_age_sec REAL,
      discovery_max REAL,
      current_multiple REAL,
      token_age_min REAL,
      reason_json TEXT NOT NULL DEFAULT '{}',
      ladder_version TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE INDEX IF NOT EXISTS idx_shadow_ladder_stage ON stage_ladder_shadow(stage_rank DESC, stage_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shadow_ladder_history_token ON stage_ladder_shadow_history(token_address, changed_at);
  `);
}

function candidateFor(row, nowMs) {
  const score = num(row.score_v2) || 0;
  const m30Age = num(row.m30_age_sec);
  const discoveryMax = num(row.discovery_max) || 0;
  const currentMultiple = num(row.current_multiple) || 0;
  const firstSeenMs = new Date(row.first_seen_at).getTime();
  const tokenAgeMin = Number.isFinite(firstSeenMs) ? Math.max(0, (nowMs - firstSeenMs) / 60000) : 0;
  const hardFail = Number(row.hard_fail || 0) > 0 || text(row.production_stage) === 'REJECTED';
  const trueM30 = m30Age != null && m30Age >= 20 && m30Age <= 35;

  let stage = 'NONE';
  const gates = {
    trueM30,
    baseScore: score >= 60,
    noHardFail: !hardFail,
    canary2: false,
    earlyAlpha: false,
    confirmedAlpha: false,
  };

  if (trueM30 && score >= 60 && !hardFail) {
    stage = 'CANARY_1';

    gates.canary2 = score >= 70 && tokenAgeMin >= 2 && discoveryMax >= 1.15 && currentMultiple >= 1.0;
    if (gates.canary2) stage = 'CANARY_2';

    gates.earlyAlpha = tokenAgeMin >= 5 && discoveryMax >= 1.5 && currentMultiple >= 1.1;
    if (gates.earlyAlpha) stage = 'EARLY_ALPHA';

    gates.confirmedAlpha = tokenAgeMin >= 10 && discoveryMax >= 2.0 && currentMultiple >= 1.2;
    if (gates.confirmedAlpha) stage = 'CONFIRMED_ALPHA';
  }

  return {
    stage,
    rank: RANK[stage] || 0,
    score,
    m30Age,
    discoveryMax,
    currentMultiple,
    tokenAgeMin: Math.round(tokenAgeMin * 100) / 100,
    productionStage: text(row.production_stage),
    hardFail,
    gates,
  };
}

export function refreshShadowStages({ limit = 1000 } = {}) {
  ensureShadowLadderSchema();
  const db = getDatabase();
  const scoreTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scores_v2_shadow'").get();
  const m30Table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='marlin_30s'").get();
  if (!scoreTable || !m30Table) {
    return { evaluated: 0, advanced: 0, stageCounts: {}, version: SHADOW_LADDER_VERSION, evaluatedAt: new Date().toISOString() };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const rows = db.prepare(`
    SELECT
      t.token_address,
      t.first_seen_at,
      t.monitor_stage AS production_stage,
      t.max_multiple_discovery AS discovery_max,
      CASE
        WHEN t.discovery_price_usd > 0 AND t.current_price_usd IS NOT NULL
        THEN t.current_price_usd / t.discovery_price_usd
        ELSE NULL
      END AS current_multiple,
      m.age_sec AS m30_age_sec,
      v.final_score AS score_v2,
      EXISTS(
        SELECT 1 FROM risk_checks r
        WHERE r.token_address=t.token_address AND r.status='FAIL'
      ) AS hard_fail
    FROM scores_v2_shadow v
    JOIN tokens t ON t.token_address=v.token_address
    JOIN marlin_30s m ON m.token_address=t.token_address
    WHERE v.score_version=?
    ORDER BY v.scored_at DESC
    LIMIT ?
  `).all(SHADOW_SCORE_VERSION, Math.max(100, Number(limit) || 1000));

  const getExisting = db.prepare('SELECT shadow_stage, stage_rank, first_qualified_at, stage_updated_at FROM stage_ladder_shadow WHERE token_address=?');
  const upsert = db.prepare(`
    INSERT INTO stage_ladder_shadow (
      token_address, shadow_stage, stage_rank, score_v2, m30_age_sec,
      discovery_max, current_multiple, token_age_min, production_stage,
      hard_fail, reason_json, ladder_version, first_qualified_at,
      stage_updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_address) DO UPDATE SET
      shadow_stage=excluded.shadow_stage,
      stage_rank=excluded.stage_rank,
      score_v2=excluded.score_v2,
      m30_age_sec=excluded.m30_age_sec,
      discovery_max=excluded.discovery_max,
      current_multiple=excluded.current_multiple,
      token_age_min=excluded.token_age_min,
      production_stage=excluded.production_stage,
      hard_fail=excluded.hard_fail,
      reason_json=excluded.reason_json,
      ladder_version=excluded.ladder_version,
      first_qualified_at=COALESCE(stage_ladder_shadow.first_qualified_at, excluded.first_qualified_at),
      stage_updated_at=CASE
        WHEN excluded.stage_rank > stage_ladder_shadow.stage_rank THEN excluded.stage_updated_at
        ELSE stage_ladder_shadow.stage_updated_at
      END,
      evaluated_at=excluded.evaluated_at
  `);
  const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO stage_ladder_shadow_history (
      stage_key, token_address, from_stage, to_stage, score_v2,
      m30_age_sec, discovery_max, current_multiple, token_age_min,
      reason_json, ladder_version, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let evaluated = 0;
  let advanced = 0;
  const stageCounts = {};
  const tx = db.transaction(() => {
    for (const row of rows) {
      const c = candidateFor(row, nowMs);
      const old = getExisting.get(row.token_address) || {
        shadow_stage: 'NONE', stage_rank: 0, first_qualified_at: null, stage_updated_at: null,
      };
      const oldRank = Number(old.stage_rank || 0);
      const finalRank = Math.max(oldRank, c.rank);
      const finalStage = Object.entries(RANK).find(([, rank]) => rank === finalRank)?.[0] || 'NONE';
      const firstQualifiedAt = old.first_qualified_at || (c.rank > 0 ? nowIso : null);
      const stageUpdatedAt = c.rank > oldRank ? nowIso : old.stage_updated_at || null;
      const reason = {
        candidateStage: c.stage,
        retainedStage: finalStage,
        scoreV2: c.score,
        m30AgeSec: c.m30Age,
        discoveryMax: c.discoveryMax,
        currentMultiple: c.currentMultiple,
        tokenAgeMin: c.tokenAgeMin,
        productionStage: c.productionStage,
        hardFail: c.hardFail,
        gates: c.gates,
        thresholds: {
          canary1: 'true M30 20-35s + v2>=60 + no hard fail',
          canary2: 'v2>=70 + age>=2m + DiscoveryMax>=1.15x + current>=1.0x',
          earlyAlpha: 'age>=5m + DiscoveryMax>=1.5x + current>=1.1x',
          confirmedAlpha: 'age>=10m + DiscoveryMax>=2x + current>=1.2x',
        },
      };

      upsert.run(
        row.token_address, finalStage, finalRank, c.score, c.m30Age,
        c.discoveryMax, c.currentMultiple, c.tokenAgeMin, c.productionStage,
        c.hardFail ? 1 : 0, safeJson(reason), SHADOW_LADDER_VERSION,
        firstQualifiedAt, stageUpdatedAt, nowIso,
      );

      if (c.rank > oldRank) {
        insertHistory.run(
          `${row.token_address}:${finalStage}:${SHADOW_LADDER_VERSION}`,
          row.token_address, text(old.shadow_stage) || 'NONE', finalStage,
          c.score, c.m30Age, c.discoveryMax, c.currentMultiple, c.tokenAgeMin,
          safeJson(reason), SHADOW_LADDER_VERSION, nowIso,
        );
        advanced += 1;
      }
      stageCounts[finalStage] = (stageCounts[finalStage] || 0) + 1;
      evaluated += 1;
    }
  });
  tx();

  return { evaluated, advanced, stageCounts, version: SHADOW_LADDER_VERSION, evaluatedAt: nowIso };
}

export function getShadowStageHealth() {
  ensureShadowLadderSchema();
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT shadow_stage AS stage, COUNT(*) AS n
    FROM stage_ladder_shadow
    GROUP BY shadow_stage
  `).all();
  const history = Number(db.prepare('SELECT COUNT(*) AS n FROM stage_ladder_shadow_history').get()?.n || 0);
  const latest = db.prepare('SELECT MAX(evaluated_at) AS at FROM stage_ladder_shadow').get()?.at || null;
  return {
    stages: Object.fromEntries(rows.map(r => [r.stage, Number(r.n || 0)])),
    history,
    latestEvaluatedAt: latest,
    version: SHADOW_LADDER_VERSION,
  };
}
