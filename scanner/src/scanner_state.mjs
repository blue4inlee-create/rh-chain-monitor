import { getDatabase } from './db.mjs';

export function ensureScannerStateSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scanner_state (
      scanner_name TEXT PRIMARY KEY,
      last_block INTEGER NOT NULL DEFAULT 0,
      last_event_index INTEGER NOT NULL DEFAULT -1,
      last_head INTEGER NOT NULL DEFAULT 0,
      resume_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < 8) db.pragma('user_version = 8');
}

export function loadScannerCursor(scannerName = 'main') {
  ensureScannerStateSchema();
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM scanner_state WHERE scanner_name=?').get(scannerName);
  if (!row) return null;
  return {
    scannerName: row.scanner_name,
    lastBlock: Number(row.last_block || 0),
    lastEventIndex: Number(row.last_event_index ?? -1),
    lastHead: Number(row.last_head || 0),
    resumeCount: Number(row.resume_count || 0),
    updatedAt: row.updated_at,
  };
}

export function saveScannerCursor(scannerName = 'main', lastBlock = 0, lastHead = 0, { resumed = false } = {}) {
  ensureScannerStateSchema();
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO scanner_state (
      scanner_name, last_block, last_event_index, last_head,
      resume_count, created_at, updated_at
    ) VALUES (?, ?, -1, ?, ?, ?, ?)
    ON CONFLICT(scanner_name) DO UPDATE SET
      last_block=excluded.last_block,
      last_head=excluded.last_head,
      resume_count=scanner_state.resume_count + ?,
      updated_at=excluded.updated_at
  `).run(
    scannerName,
    Number(lastBlock || 0),
    Number(lastHead || 0),
    resumed ? 1 : 0,
    now,
    now,
    resumed ? 1 : 0,
  );
  return loadScannerCursor(scannerName);
}
