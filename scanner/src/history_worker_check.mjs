import { rmSync } from 'node:fs';

const path = `/tmp/rh-history-check-${process.pid}.db`;
process.env.SQLITE_PATH = path;

const { initializeDatabase, getDatabase, closeDatabase } = await import('./db.mjs');
const { ensureStageSchema } = await import('./stages.mjs');
const { ensurePriceMilestoneSchema } = await import('./price_milestones.mjs');
const { ensureAthSchema, recordMarketTick } = await import('./ath_metrics.mjs');
const {
  ensureSignalOutcomeSchema,
  syncOutcomesFromAlerts,
  recordOutcomeSample,
  recomputeOutcome,
} = await import('./signal_outcomes.mjs');
const { getHistoryCalibrationRows } = await import('./history_calibration.mjs');

function assert(ok, message) {
  if (!ok) throw new Error(message);
}
function iso(base, ms) { return new Date(new Date(base).getTime() + ms).toISOString(); }

try {
  initializeDatabase();
  ensureStageSchema();
  ensurePriceMilestoneSchema();
  ensureAthSchema();
  ensureSignalOutcomeSchema();
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      token_address TEXT NOT NULL,
      symbol TEXT DEFAULT '',
      score REAL,
      confidence REAL,
      liquidity REAL,
      risk_gate TEXT DEFAULT '',
      triggered_at TEXT NOT NULL,
      bark_status TEXT DEFAULT 'PENDING',
      telegram_status TEXT DEFAULT 'PENDING'
    );
  `);

  const token = '0x1111111111111111111111111111111111111111';
  const t0 = '2026-09-11T00:00:00.000Z';
  db.prepare(`
    INSERT INTO tokens (
      token_address,symbol,first_seen_at,last_seen_at,first_source,stage,
      raw_payload,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(token, 'TEST', t0, t0, 'test', 'CANARY', '{}', t0, t0);

  recordMarketTick({ tokenAddress: token, tickAt: t0, priceUsd: 1, marketCap: 100000, liquidityUsd: 25000, source: 'test' });
  db.prepare(`
    INSERT INTO alert_events
      (event_key,event_type,token_address,symbol,score,confidence,liquidity,risk_gate,triggered_at,bark_status,telegram_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(`${token}|EARLY_ALPHA|${t0}`, 'EARLY_ALPHA', token, 'TEST', 86, 82, 25000, 'CLEAR', t0, 'SENT', 'SENT');

  assert(syncOutcomesFromAlerts() === 1, 'expected one alert outcome');
  const samples = [
    [15 * 60_000, 1.40],
    [60 * 60_000, 1.60],
    [6 * 60 * 60_000, 0.80],
    [12 * 60 * 60_000, 1.30],
    [24 * 60 * 60_000, 2.10],
  ];
  for (const [ms, price] of samples) {
    recordOutcomeSample({
      eventKey: `${token}|EARLY_ALPHA|${t0}`,
      tokenAddress: token,
      sampleAt: iso(t0, ms),
      priceUsd: price,
      marketCap: price * 100000,
      liquidityUsd: 25000,
      source: 'test',
    });
  }
  const row = recomputeOutcome(`${token}|EARLY_ALPHA|${t0}`, new Date(iso(t0, 24 * 60 * 60_000 + 60_000)));
  assert(row.status === 'COMPLETE', 'outcome should complete after 24h sample');
  assert(Math.abs(Number(row.m15_return_pct) - 40) < 0.001, '15m return mismatch');
  assert(Math.abs(Number(row.h1_return_pct) - 60) < 0.001, '1h return mismatch');
  assert(Math.abs(Number(row.h24_return_pct) - 110) < 0.001, '24h return mismatch');
  assert(Number(row.hit_100) === 1, 'expected +100 hit');
  assert(Number(row.clean_win_30) === 1, 'expected clean +30 before -30');
  assert(Number(row.max_drawdown_pct) <= -49.9, 'expected peak-to-trough drawdown');
  assert(row.outcome_label === 'MULTIBAGGER', 'expected multibagger label');
  const calibration = getHistoryCalibrationRows();
  assert(calibration.some(x => x.dimension === 'Score' && x.bucket === '85+'), 'score calibration bucket missing');
  console.log('history worker check ok');
} finally {
  try { closeDatabase(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch {}
  }
}
