import { writeFile, rename } from 'node:fs/promises';
import { getDatabase, getDatabaseHealth } from './db.mjs';
import { getDeadLetterStats } from './dead_letter.mjs';
import { getPriceMilestoneHealth } from './price_milestones.mjs';
import { getAthHealth } from './ath_metrics.mjs';
import { getStageHealth } from './stages.mjs';

const STATUS_PATH = process.env.RUNTIME_STATUS_PATH || '/data/runtime_status.json';

function text(v) { return v == null ? '' : String(v); }
function safeJson(v) {
  try { return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x); }
  catch { return '{}'; }
}

export function ensureOpsSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'INFO',
      component TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ops_events_created ON ops_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ops_events_component ON ops_events(component, created_at DESC);
  `);
  return true;
}

export function recordOpsEvent({ level='INFO', component='', event='', message='', details={} }={}) {
  ensureOpsSchema();
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ops_events(level, component, event, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(text(level).toUpperCase(), text(component), text(event), text(message), safeJson(details), now);
  db.prepare(`DELETE FROM ops_events WHERE id NOT IN (SELECT id FROM ops_events ORDER BY id DESC LIMIT 2000)`).run();
  return now;
}

export function getOpsHealth() {
  ensureOpsSchema();
  const db = getDatabase();
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get()?.n || 0);
  const latest = db.prepare(`SELECT level, component, event, message, created_at FROM ops_events ORDER BY id DESC LIMIT 1`).get() || null;
  const errors24h = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM ops_events
    WHERE level='ERROR' AND created_at >= datetime('now','-1 day')
  `).get()?.n || 0);
  return { total, errors24h, latest };
}

export async function writeRuntimeStatus(extra={}) {
  ensureOpsSchema();
  const status = {
    ok: true,
    service: 'scanner-monitor',
    version: text(extra.version || ''),
    generatedAt: new Date().toISOString(),
    db: getDatabaseHealth(),
    deadLetters: getDeadLetterStats(),
    priceMilestones: getPriceMilestoneHealth(),
    ath: getAthHealth(),
    stages: getStageHealth(),
    ops: getOpsHealth(),
    workers: extra.workers || {},
    sheetSync: extra.sheetSync || {},
    config: extra.config || {},
  };
  const tmp = `${STATUS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(status), 'utf8');
  await rename(tmp, STATUS_PATH);
  return status;
}

export { STATUS_PATH };
