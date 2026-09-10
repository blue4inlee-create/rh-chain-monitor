import { getDatabase } from './db.mjs';

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
}

export function saveOpportunityRows(rows = []) {
  ensureOpportunitySchema();
  const db = getDatabase();
  const stmt = db.prepare(`INSERT INTO opportunity_pool
  (token_address,symbol,stage,score,market_cap,liquidity,volume24h,holders,payload,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(token_address) DO UPDATE SET
  symbol=excluded.symbol, stage=excluded.stage, score=excluded.score,
  market_cap=excluded.market_cap, liquidity=excluded.liquidity,
  volume24h=excluded.volume24h, holders=excluded.holders,
  payload=excluded.payload, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  const tx = db.transaction(items => {
    for (const r of items) stmt.run(r.address, r.symbol || '', r.stage || '', Number(r.score || 0), r.marketCap ?? null, r.liquidity ?? null, r.volume24h ?? null, r.holders ?? null, JSON.stringify(r), now);
  });
  tx(rows);
}

export function getOpportunityRows(limit = 100) {
  ensureOpportunitySchema();
  return getDatabase().prepare('SELECT * FROM opportunity_pool ORDER BY score DESC LIMIT ?').all(limit);
}
