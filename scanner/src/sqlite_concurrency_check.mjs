import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dir = mkdtempSync(join(tmpdir(), 'rh-sqlite-check-'));
const file = join(dir, 'test.db');
try {
  const a = new Database(file);
  a.pragma('busy_timeout = 30000');
  a.pragma('journal_mode = WAL');
  a.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
  a.close();

  const b = new Database(file);
  b.pragma('busy_timeout = 30000');
  const mode = String(b.pragma('journal_mode', { simple: true }) || '').toLowerCase();
  assert(mode === 'wal', 'database should remain in WAL mode');
  assert(Number(b.pragma('busy_timeout', { simple: true })) >= 30000, 'busy_timeout should be at least 30s');
  b.close();
  console.log('sqlite concurrency check ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
