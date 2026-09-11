import Database from 'better-sqlite3';

const DB_PATH = process.env.SQLITE_PATH || '/data/rh_monitor.db';
const RETENTION_HOURS = Math.max(24, Number(process.env.MARKET_TICK_RETENTION_HOURS || 48));
const BATCH_SIZE = Math.max(500, Math.min(10000, Number(process.env.STORAGE_CLEAN_BATCH || 5000)));
const MAX_BATCHES = Math.max(1, Math.min(200, Number(process.env.STORAGE_CLEAN_MAX_BATCHES || 100)));
const INTERVAL_MS = Math.max(15 * 60_000, Number(process.env.STORAGE_MAINTENANCE_INTERVAL_MS || 60 * 60_000));
const ONCE = /^(1|true|yes)$/i.test(String(process.env.STORAGE_MAINTENANCE_ONCE || 'false'));

function openDb() {
  const db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function stats(db) {
  const pageSize = Number(db.pragma('page_size', { simple: true }) || 0);
  const pageCount = Number(db.pragma('page_count', { simple: true }) || 0);
  const freelist = Number(db.pragma('freelist_count', { simple: true }) || 0);
  return {
    pageSize,
    pageCount,
    freelist,
    dbMb: Number((pageSize * pageCount / 1024 / 1024).toFixed(2)),
    reusableMb: Number((pageSize * freelist / 1024 / 1024).toFixed(2)),
  };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function maintainStorage() {
  const db = openDb();
  const startedAt = new Date().toISOString();
  let checkpointBefore = null;
  let checkpointAfter = null;
  let deletedTicks = 0;
  let eligibleTicks = 0;

  try {
    try { checkpointBefore = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false }); }
    catch (err) { checkpointBefore = { error: String(err?.message || err) }; }

    if (hasTable(db, 'market_ticks')) {
      const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();
      eligibleTicks = Number(db.prepare('SELECT COUNT(*) AS n FROM market_ticks WHERE tick_at < ?').get(cutoff)?.n || 0);
      const deleteBatch = db.prepare(`
        DELETE FROM market_ticks
        WHERE id IN (
          SELECT id FROM market_ticks
          WHERE tick_at < ?
          ORDER BY id ASC
          LIMIT ?
        )
      `);

      for (let i = 0; i < MAX_BATCHES; i++) {
        const result = db.transaction(() => deleteBatch.run(cutoff, BATCH_SIZE))();
        const changed = Number(result.changes || 0);
        deletedTicks += changed;
        if (!changed) break;
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
        if (changed < BATCH_SIZE) break;
      }
    }

    try { checkpointAfter = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false }); }
    catch (err) { checkpointAfter = { error: String(err?.message || err) }; }

    const result = {
      ok: true,
      startedAt,
      retentionHours: RETENTION_HOURS,
      batchSize: BATCH_SIZE,
      eligibleTicks,
      deletedTicks,
      checkpointBefore,
      checkpointAfter,
      ...stats(db),
    };
    console.log('[storage maintenance]', JSON.stringify(result));
    return result;
  } finally {
    db.close();
  }
}

async function main() {
  try {
    maintainStorage();
  } catch (err) {
    console.error('[storage maintenance fatal]', err);
    if (ONCE) process.exitCode = 1;
  }

  if (ONCE) return;
  const timer = setInterval(() => {
    try { maintainStorage(); }
    catch (err) { console.error('[storage maintenance]', err?.message || err); }
  }, INTERVAL_MS);
  timer.unref();
  await new Promise(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) main();
