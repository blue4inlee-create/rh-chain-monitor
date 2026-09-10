import Database from 'better-sqlite3';

export const DB_PATH = process.env.SQLITE_PATH || '/data/rh_monitor.db';

export function openDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initializeDatabase() {
  const db = openDatabase();
  try {
    const journalMode = db.pragma('journal_mode', { simple: true });
    const synchronous = db.pragma('synchronous', { simple: true });
    const busyTimeout = db.pragma('busy_timeout', { simple: true });
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    const userVersion = db.pragma('user_version', { simple: true });
    return {
      path: DB_PATH,
      journalMode,
      synchronous,
      busyTimeout,
      foreignKeys,
      userVersion,
    };
  } finally {
    db.close();
  }
}
