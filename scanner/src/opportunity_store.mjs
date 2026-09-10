import { getDatabase } from './db.mjs';

export function initOpportunityStore() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'watching',
      market_cap REAL,
      liquidity REAL,
      volume_24h REAL,
      holders INTEGER,
      score REAL DEFAULT 0,
      source TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_opportunity_score ON opportunity_pool(score DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunity_status ON opportunity_pool(status);
  `);
  return true;
}

export function upsertOpportunity(item = {}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO opportunity_pool
    (token_address,symbol,stage,status,market_cap,liquidity,volume_24h,holders,score,source,tags,created_at,updated_at)
    VALUES (@token_address,@symbol,@stage,@status,@market_cap,@liquidity,@volume_24h,@holders,@score,@source,@tags,@created_at,@updated_at)
    ON CONFLICT(token_address) DO UPDATE SET
      symbol=excluded.symbol,
      stage=excluded.stage,
      status=excluded.status,
      market_cap=excluded.market_cap,
      liquidity=excluded.liquidity,
      volume_24h=excluded.volume_24h,
      holders=excluded.holders,
      score=excluded.score,
      source=excluded.source,
      tags=excluded.tags,
      updated_at=excluded.updated_at
  `).run({
    token_address: item.address || item.ca || '',
    symbol: item.symbol || '',
    stage: item.stage || 'discovery',
    status: item.status || 'watching',
    market_cap: Number(item.marketCap || 0),
    liquidity: Number(item.liquidity || 0),
    volume_24h: Number(item.volume24h || 0),
    holders: Number(item.holders || 0),
    score: Number(item.score || 0),
    source: item.source || 'scanner',
    tags: JSON.stringify(item.tags || []),
    created_at: now,
    updated_at: now
  });
}

export function listOpportunities(limit = 100) {
  return getDatabase().prepare(
    'SELECT * FROM opportunity_pool ORDER BY score DESC LIMIT ?'
  ).all(limit);
}
