import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const ROOT = process.env.STORAGE_PROBE_ROOT || '/data';
const DB_PATH = process.env.SQLITE_PATH || '/data/rh_monitor.db';
const MAX_DEPTH = 3;

async function walk(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) await walk(path, depth + 1, out);
      else if (entry.isFile()) {
        const s = await stat(path);
        out.push({ path, bytes: s.size });
      }
    } catch {}
  }
  return out;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function safeOne(db, sql) {
  try { return db.prepare(sql).get() || {}; }
  catch (err) { return { error: String(err?.message || err) }; }
}

function probeDb() {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const pageSize = Number(db.pragma('page_size', { simple: true }) || 0);
    const pageCount = Number(db.pragma('page_count', { simple: true }) || 0);
    const freelist = Number(db.pragma('freelist_count', { simple: true }) || 0);
    const tables = {};

    const defs = [
      ['tokens', "COUNT(*) AS rows, SUM(LENGTH(raw_payload)) AS payload_bytes"],
      ['pools', "COUNT(*) AS rows, SUM(LENGTH(raw_payload)) AS payload_bytes"],
      ['jobs', "COUNT(*) AS rows, SUM(LENGTH(payload)) AS payload_bytes"],
      ['snapshots', "COUNT(*) AS rows, SUM(LENGTH(raw_data)) AS payload_bytes"],
      ['market_ticks', "COUNT(*) AS rows, SUM(LENGTH(raw_data)) AS payload_bytes, MIN(tick_at) AS oldest, MAX(tick_at) AS newest"],
      ['risk_checks', "COUNT(*) AS rows, SUM(LENGTH(details)) AS payload_bytes"],
      ['scores', "COUNT(*) AS rows, SUM(LENGTH(reason_json)) AS payload_bytes"],
      ['scores_v2_shadow', "COUNT(*) AS rows, SUM(LENGTH(reason_json)) AS payload_bytes"],
      ['stage_history', "COUNT(*) AS rows, SUM(LENGTH(reason_json)) AS payload_bytes"],
      ['ops_events', "COUNT(*) AS rows, SUM(LENGTH(details_json)) AS payload_bytes"],
      ['opportunity_pool', "COUNT(*) AS rows, SUM(LENGTH(payload)) AS payload_bytes"],
      ['marlin_30s', "COUNT(*) AS rows"],
      ['market_ticks', "COUNT(*) FILTER (WHERE tick_at < datetime('now','-4 hours')) AS older_4h, COUNT(*) FILTER (WHERE tick_at < datetime('now','-24 hours')) AS older_24h"]
    ];

    for (const [name, expr] of defs) {
      if (!tableExists(db, name)) continue;
      const key = tables[name] ? `${name}_age` : name;
      const row = safeOne(db, `SELECT ${expr} FROM ${name}`);
      if (row.payload_bytes != null) {
        row.payload_mb = Number((Number(row.payload_bytes || 0) / 1024 / 1024).toFixed(2));
      }
      tables[key] = row;
    }

    db.close();
    return {
      ok: true,
      pageSize,
      pageCount,
      freelist,
      dbMb: Number((pageSize * pageCount / 1024 / 1024).toFixed(2)),
      freeInsideDbMb: Number((pageSize * freelist / 1024 / 1024).toFixed(2)),
      tables,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

const rows = await walk(ROOT);
rows.sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((sum, x) => sum + x.bytes, 0);
console.log('[storage probe]', JSON.stringify({
  root: ROOT,
  files: rows.length,
  totalBytes: total,
  top: rows.slice(0, 20).map(x => ({ ...x, mb: Number((x.bytes / 1024 / 1024).toFixed(2)) })),
  sqlite: probeDb(),
}));
