import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';
import { buildOpportunityCandidates } from './opportunity_pool_sync.mjs';

const INTERVAL_MS = Math.max(30_000, Number(process.env.OPPORTUNITY_REFRESH_MS || 60_000));
let stopping = false;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function latestSnapshots(db) {
  if (!tableExists(db, 'snapshots')) return [];
  return db.prepare(`
    SELECT s.*
    FROM snapshots s
    JOIN (
      SELECT token_address, MAX(id) AS id
      FROM snapshots
      GROUP BY token_address
    ) x ON x.id=s.id
  `).all();
}

function fastRows(db) {
  if (!tableExists(db, 'marlin_30s')) return [];
  return db.prepare('SELECT * FROM marlin_30s').all();
}

function canaryRows(tokens = []) {
  return tokens.map(t => ({
    token_address: t.token_address,
    stage: t.monitor_stage || t.stage || 'discovery',
  }));
}

export function refreshOpportunityPool() {
  initializeDatabase();
  const db = getDatabase();
  const tokens = db.prepare('SELECT * FROM tokens ORDER BY first_seen_at DESC').all();
  const snapshots = latestSnapshots(db);
  const fastM30 = fastRows(db);
  const canary = canaryRows(tokens);
  const pool = buildOpportunityCandidates({ tokens, snapshots, fastM30, canary });
  const top = pool.slice(0, 5).map(x => ({
    symbol: x.symbol,
    address: x.address,
    score: x.score,
    classification: x.classification,
    confidence: x.confidence,
  }));
  return { tokens: tokens.length, rows: pool.length, top };
}

async function main() {
  while (!stopping) {
    try {
      const result = refreshOpportunityPool();
      console.log('[opportunity worker]', JSON.stringify(result));
    } catch (err) {
      console.error('[opportunity worker]', err?.stack || err?.message || err);
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

function shutdown() {
  stopping = true;
  try { closeDatabase(); } catch {}
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[opportunity worker fatal]', err?.stack || err);
    process.exitCode = 1;
  });
}
