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
      if (entry.isDirectory()) {
        await walk(path, depth + 1, out);
      } else if (entry.isFile()) {
        const s = await stat(path);
        out.push({ path, bytes: s.size });
      }
    } catch {}
  }
  return out;
}

function probeDb() {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const pageSize = Number(db.pragma('page_size', { simple: true }) || 0);
    const pageCount = Number(db.pragma('page_count', { simple: true }) || 0);
    const freelist = Number(db.pragma('freelist_count', { simple: true }) || 0);
    let objects = [];
    try {
      objects = db.prepare(`
        SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages
        FROM dbstat
        GROUP BY name
        ORDER BY bytes DESC
        LIMIT 30
      `).all().map(r => ({
        name: r.name,
        bytes: Number(r.bytes || 0),
        mb: Number((Number(r.bytes || 0) / 1024 / 1024).toFixed(2)),
        pages: Number(r.pages || 0),
      }));
    } catch (err) {
      objects = [{ error: String(err?.message || err) }];
    }
    db.close();
    return {
      ok: true,
      pageSize,
      pageCount,
      freelist,
      dbMb: Number((pageSize * pageCount / 1024 / 1024).toFixed(2)),
      freeInsideDbMb: Number((pageSize * freelist / 1024 / 1024).toFixed(2)),
      objects,
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
