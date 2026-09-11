import { getDatabase } from './db.mjs';

function addColumnIfMissing(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function ensureOpportunitySchema() {
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

  db.exec(`CREATE INDEX IF NOT EXISTS idx_opportunity_score ON opportunity_pool(score DESC, updated_at DESC);`);
}

export function saveOpportunityRows(rows = []) {
  ensureOpportunitySchema();
  const db = getDatabase();
  const stmt = db.prepare(`INSERT INTO opportunity_pool
  (token_address,symbol,stage,score,market_cap,liquidity,volume24h,holders,payload,updated_at,classification,score_confidence,score_version,score_breakdown)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(token_address) DO UPDATE SET
  symbol=excluded.symbol, stage=excluded.stage, score=excluded.score,
  market_cap=excluded.market_cap, liquidity=excluded.liquidity,
  volume24h=excluded.volume24h, holders=excluded.holders,
  payload=excluded.payload, updated_at=excluded.updated_at,
  classification=excluded.classification,
  score_confidence=excluded.score_confidence,
  score_version=excluded.score_version,
  score_breakdown=excluded.score_breakdown`);
  const now = new Date().toISOString();
  const tx = db.transaction(items => {
    for (const r of items) {
      stmt.run(
        String(r.address || '').toLowerCase(),
        r.symbol || '',
        r.stage || '',
        Number(r.score || 0),
        r.marketCap ?? null,
        r.liquidity ?? null,
        r.volume24h ?? null,
        r.holders ?? null,
        JSON.stringify(r),
        now,
        r.classification || 'observe',
        Number(r.confidence || 0),
        r.scoreVersion || '',
        JSON.stringify(r.scoreBreakdown || {}),
      );
    }
  });
  tx(rows);
}

export function getOpportunityRows(limit = 100) {
  ensureOpportunitySchema();
  return getDatabase().prepare('SELECT * FROM opportunity_pool ORDER BY score DESC, updated_at DESC LIMIT ?').all(limit);
}
