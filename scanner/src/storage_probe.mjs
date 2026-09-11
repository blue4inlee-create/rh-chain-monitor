import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.STORAGE_PROBE_ROOT || '/data';
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

const rows = await walk(ROOT);
rows.sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((sum, x) => sum + x.bytes, 0);
console.log('[storage probe]', JSON.stringify({
  root: ROOT,
  files: rows.length,
  totalBytes: total,
  top: rows.slice(0, 20).map(x => ({ ...x, mb: Number((x.bytes / 1024 / 1024).toFixed(2)) })),
}));
