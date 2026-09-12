import { getDatabase } from './db.mjs';

const WRITE_CHUNK = Math.max(10, Math.min(250, Number(process.env.OPPORTUNITY_WRITE_CHUNK || 50)));
const WRITE_YIELD_MS = Math.max(0, Math.min(100, Number(process.env.OPPORTUNITY_WRITE_YIELD_MS || 8)));
const BUSY_RETRIES = Math.max(0, Math.min(10, Number(process.env.OPPORTUNITY_BUSY_RETRIES || 6)));
let schemaReady = false;

function isBusy(err) {
  return /SQLITE_BUSY|database is locked/i.test(String(err?.code || '') + ' ' + String(err?.message || err || ''));
}

function blockingSleep(ms) {
  if (!(ms > 0)) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function addColumnIfMissing(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function ensureOpportunitySchema() {
  if (schemaReady) return;
  const db = getDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS opportunity_pool (
    token_address TEXT PRIMARY KEY,
    symbol TEXT DEFAULT '',
    stage TEXT DEFAULT '',
    score REAL DEFAULT 0,
    market_cap REAL,
    liquidity REAL,
    volume24h REAL,
    holders INTEGER,
    payload TEXT DEFAULT '{}',
    updated_at TEXT NOT NULL
  );`);

  addColumnIfMissing(db, 'opportunity_pool', 'classification', "TEXT DEFAULT 'observe'");
  addColumnIfMissing(db, 'opportunity_pool', 'score_confidence', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'opportunity_pool', 'score_version', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'opportunity_pool', 'score_breakdown', "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, 'opportunity_pool', 'risk_gate', "TEXT DEFAULT 'CAUTION'");
  addColumnIfMissing(db, 'opportunity_pool', 'risk_confidence', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'opportunity_pool', 'buy_blocked', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'opportunity_pool', 'hard_fail_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'opportunity_pool', 'warn_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'opportunity_pool', 'critical_unknown_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'opportunity_pool', 'risk_reasons', "TEXT DEFAULT '[]'");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_opportunity_score ON opportunity_pool(score DESC, updated_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_opportunity_gate ON opportunity_pool(buy_blocked, risk_gate, score DESC);`);
  schemaReady = true;
}

export function saveOpportunityRows(rows = []) {
  ensureOpportunitySchema();
  const db = getDatabase();
  const stmt = db.prepare(`INSERT INTO opportunity_pool
  (token_address,symbol,stage,score,market_cap,liquidity,volume24h,holders,payload,updated_at,
   classification,score_confidence,score_version,score_breakdown,risk_gate,risk_confidence,
   buy_blocked,hard_fail_count,warn_count,critical_unknown_count,risk_reasons)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(token_address) DO UPDATE SET
  symbol=excluded.symbol, stage=excluded.stage, score=excluded.score,
  market_cap=excluded.market_cap, liquidity=excluded.liquidity,
  volume24h=excluded.volume24h, holders=excluded.holders,
  payload=excluded.payload, updated_at=excluded.updated_at,
  classification=excluded.classification,
  score_confidence=excluded.score_confidence,
  score_version=excluded.score_version,
  score_breakdown=excluded.score_breakdown,
  risk_gate=excluded.risk_gate,
  risk_confidence=excluded.risk_confidence,
  buy_blocked=excluded.buy_blocked,
  hard_fail_count=excluded.hard_fail_count,
  warn_count=excluded.warn_count,
  critical_unknown_count=excluded.critical_unknown_count,
  risk_reasons=excluded.risk_reasons`);
  const now = new Date().toISOString();
  const writeChunk = db.transaction(items => {
    for (const r of items) {
      stmt.run(
        String(r.address || '').toLowerCase(), r.symbol || '', r.stage || '', Number(r.score || 0),
        r.marketCap ?? null, r.liquidity ?? null, r.volume24h ?? null, r.holders ?? null,
        JSON.stringify(r), now, r.classification || 'observe', Number(r.confidence || 0),
        r.scoreVersion || '', JSON.stringify(r.scoreBreakdown || {}), r.riskGate || 'CAUTION',
        Number(r.riskConfidence || 0), r.buyBlocked ? 1 : 0, Number(r.hardFailCount || 0),
        Number(r.warnCount || 0), Number(r.criticalUnknownCount || 0), JSON.stringify(r.riskReasons || []),
      );
    }
  });

  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    let attempt = 0;
    while (true) {
      try {
        writeChunk(chunk);
        break;
      } catch (err) {
        if (!isBusy(err) || attempt >= BUSY_RETRIES) throw err;
        blockingSleep(Math.min(1000, 25 * (2 ** attempt)));
        attempt += 1;
      }
    }
    if (i + WRITE_CHUNK < rows.length) blockingSleep(WRITE_YIELD_MS);
  }
}

export function getOpportunityRows(limit = 100) {
  ensureOpportunitySchema();
  return getDatabase().prepare(`
    SELECT * FROM opportunity_pool
    ORDER BY buy_blocked ASC,
             CASE risk_gate WHEN 'CLEAR' THEN 0 WHEN 'CAUTION' THEN 1 ELSE 2 END ASC,
             score DESC, updated_at DESC
    LIMIT ?
  `).all(limit);
}
