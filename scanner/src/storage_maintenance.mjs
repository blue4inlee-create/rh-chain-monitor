import Database from 'better-sqlite3';

const DB_PATH = process.env.SQLITE_PATH || '/data/rh_monitor.db';
const DISCOVERY_RETENTION_HOURS = Math.max(1, Number(process.env.DISCOVERY_TICK_RETENTION_HOURS || 4));
const CANARY_RETENTION_HOURS = Math.max(4, Number(process.env.CANARY_TICK_RETENTION_HOURS || 24));
const BATCH_SIZE = Math.max(50, Math.min(2000, Number(process.env.STORAGE_CLEAN_BATCH || 250)));
const MAX_BATCHES = Math.max(1, Math.min(2000, Number(process.env.STORAGE_CLEAN_MAX_BATCHES || 1000)));
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

function hasColumn(db, table, column) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column); }
  catch { return false; }
}

function checkpoint(db) {
  try { return db.pragma('wal_checkpoint(TRUNCATE)', { simple: false }); }
  catch (err) { return { error: String(err?.message || err) }; }
}

function deleteBatches(db, selectSql, params, limit = MAX_BATCHES) {
  let deleted = 0;
  let error = null;
  const stmt = db.prepare(`DELETE FROM market_ticks WHERE id IN (${selectSql})`);

  for (let i = 0; i < limit; i++) {
    try {
      const result = db.transaction(() => stmt.run(...params, BATCH_SIZE))();
      const changed = Number(result.changes || 0);
      deleted += changed;
      if (!changed) break;
      checkpoint(db);
      if (changed < BATCH_SIZE) break;
    } catch (err) {
      error = String(err?.message || err);
      break;
    }
  }
  return { deleted, error };
}

export function maintainStorage() {
  const db = openDb();
  const startedAt = new Date().toISOString();
  const before = stats(db);
  let checkpointBefore = null;
  let checkpointAfter = null;
  let discoveryEligible = 0;
  let canaryEligible = 0;
  let discoveryDeleted = 0;
  let canaryDeleted = 0;
  let deleteError = null;

  try {
    checkpointBefore = checkpoint(db);

    if (hasTable(db, 'market_ticks') && hasTable(db, 'tokens')) {
      const discoveryCutoff = new Date(Date.now() - DISCOVERY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
      const canaryCutoff = new Date(Date.now() - CANARY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
      const hasCanaryAt = hasColumn(db, 'tokens', 'canary_at');

      if (hasCanaryAt) {
        discoveryEligible = Number(db.prepare(`
          SELECT COUNT(*) AS n
          FROM market_ticks mt
          LEFT JOIN tokens t ON t.token_address=mt.token_address
          WHERE mt.tick_at < ? AND t.canary_at IS NULL
        `).get(discoveryCutoff)?.n || 0);

        canaryEligible = Number(db.prepare(`
          SELECT COUNT(*) AS n
          FROM market_ticks mt
          JOIN tokens t ON t.token_address=mt.token_address
          WHERE mt.tick_at < ? AND t.canary_at IS NOT NULL
        `).get(canaryCutoff)?.n || 0);

        const d = deleteBatches(db, `
          SELECT mt.id
          FROM market_ticks mt
          LEFT JOIN tokens t ON t.token_address=mt.token_address
          WHERE mt.tick_at < ? AND t.canary_at IS NULL
          ORDER BY mt.id ASC
          LIMIT ?
        `, [discoveryCutoff]);
        discoveryDeleted = d.deleted;
        deleteError = d.error;

        if (!deleteError) {
          const c = deleteBatches(db, `
            SELECT mt.id
            FROM market_ticks mt
            JOIN tokens t ON t.token_address=mt.token_address
            WHERE mt.tick_at < ? AND t.canary_at IS NOT NULL
            ORDER BY mt.id ASC
            LIMIT ?
          `, [canaryCutoff]);
          canaryDeleted = c.deleted;
          deleteError = c.error;
        }
      } else {
        discoveryEligible = Number(db.prepare('SELECT COUNT(*) AS n FROM market_ticks WHERE tick_at < ?').get(discoveryCutoff)?.n || 0);
        const d = deleteBatches(db, `
          SELECT id FROM market_ticks
          WHERE tick_at < ?
          ORDER BY id ASC
          LIMIT ?
        `, [discoveryCutoff]);
        discoveryDeleted = d.deleted;
        deleteError = d.error;
      }
    }

    checkpointAfter = checkpoint(db);
    const after = stats(db);
    const result = {
      ok: !deleteError,
      startedAt,
      discoveryRetentionHours: DISCOVERY_RETENTION_HOURS,
      canaryRetentionHours: CANARY_RETENTION_HOURS,
      batchSize: BATCH_SIZE,
      discoveryEligible,
      canaryEligible,
      discoveryDeleted,
      canaryDeleted,
      deleteError,
      checkpointBefore,
      checkpointAfter,
      before,
      after,
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
