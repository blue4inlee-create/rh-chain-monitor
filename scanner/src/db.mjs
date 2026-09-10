import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.SQLITE_PATH || '/data/rh_monitor.db';
let sharedDb = null;

function ensureParentDir() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

function configure(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  } catch {
    return '{}';
  }
}

function txt(v) {
  return v == null ? '' : String(v).trim();
}

function lc(v) {
  return txt(v).toLowerCase();
}

function poolKeyFor(event) {
  const pool = txt(event.pool);
  if (!pool) return '';
  return lc(pool);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token_address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      decimals INTEGER,
      total_supply TEXT NOT NULL DEFAULT '',
      creator_address TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      first_source TEXT NOT NULL DEFAULT '',
      first_pool_key TEXT NOT NULL DEFAULT '',
      pool_count INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT '',
      discovery_tx TEXT NOT NULL DEFAULT '',
      discovery_block INTEGER,
      raw_payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_key TEXT NOT NULL UNIQUE,
      pool_address TEXT NOT NULL DEFAULT '',
      token_address TEXT NOT NULL,
      dex TEXT NOT NULL DEFAULT '',
      pool_version TEXT NOT NULL DEFAULT '',
      quote_token TEXT NOT NULL DEFAULT '',
      quote_symbol TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT '',
      discovered_at TEXT NOT NULL,
      block_number INTEGER,
      tx_hash TEXT NOT NULL DEFAULT '',
      creator_address TEXT NOT NULL DEFAULT '',
      raw_payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE INDEX IF NOT EXISTS idx_pools_token_address ON pools(token_address);
    CREATE INDEX IF NOT EXISTS idx_pools_discovered_at ON pools(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_pools_tx_hash ON pools(tx_hash);
    CREATE INDEX IF NOT EXISTS idx_tokens_first_seen_at ON tokens(first_seen_at);
  `);
  db.pragma('user_version = 2');
}

export function openDatabase() {
  ensureParentDir();
  const db = new Database(DB_PATH);
  configure(db);
  migrate(db);
  return db;
}

export function getDatabase() {
  if (!sharedDb) sharedDb = openDatabase();
  return sharedDb;
}

export function initializeDatabase() {
  const db = getDatabase();
  const journalMode = db.pragma('journal_mode', { simple: true });
  const synchronous = db.pragma('synchronous', { simple: true });
  const busyTimeout = db.pragma('busy_timeout', { simple: true });
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  const userVersion = db.pragma('user_version', { simple: true });
  const counts = getDatabaseHealth();
  return {
    path: DB_PATH,
    journalMode,
    synchronous,
    busyTimeout,
    foreignKeys,
    userVersion,
    ...counts,
  };
}

const upsertTokenSql = `
  INSERT INTO tokens (
    token_address, symbol, creator_address, first_seen_at, last_seen_at,
    first_source, stage, discovery_tx, discovery_block, raw_payload, created_at, updated_at
  ) VALUES (
    @token_address, @symbol, @creator_address, @first_seen_at, @last_seen_at,
    @first_source, @stage, @discovery_tx, @discovery_block, @raw_payload, @created_at, @updated_at
  )
  ON CONFLICT(token_address) DO UPDATE SET
    symbol = CASE WHEN excluded.symbol <> '' THEN excluded.symbol ELSE tokens.symbol END,
    creator_address = CASE WHEN tokens.creator_address = '' AND excluded.creator_address <> '' THEN excluded.creator_address ELSE tokens.creator_address END,
    last_seen_at = excluded.last_seen_at,
    stage = CASE WHEN excluded.stage <> '' THEN excluded.stage ELSE tokens.stage END,
    discovery_tx = CASE WHEN tokens.discovery_tx = '' AND excluded.discovery_tx <> '' THEN excluded.discovery_tx ELSE tokens.discovery_tx END,
    discovery_block = COALESCE(tokens.discovery_block, excluded.discovery_block),
    raw_payload = excluded.raw_payload,
    updated_at = excluded.updated_at
`;

const insertPoolSql = `
  INSERT OR IGNORE INTO pools (
    pool_key, pool_address, token_address, dex, pool_version, quote_token,
    quote_symbol, source, stage, discovered_at, block_number, tx_hash,
    creator_address, raw_payload, created_at, updated_at
  ) VALUES (
    @pool_key, @pool_address, @token_address, @dex, @pool_version, @quote_token,
    @quote_symbol, @source, @stage, @discovered_at, @block_number, @tx_hash,
    @creator_address, @raw_payload, @created_at, @updated_at
  )
`;

const updatePoolSql = `
  UPDATE pools SET
    pool_address = CASE WHEN @pool_address <> '' THEN @pool_address ELSE pool_address END,
    dex = CASE WHEN @dex <> '' THEN @dex ELSE dex END,
    pool_version = CASE WHEN @pool_version <> '' THEN @pool_version ELSE pool_version END,
    quote_token = CASE WHEN @quote_token <> '' THEN @quote_token ELSE quote_token END,
    quote_symbol = CASE WHEN @quote_symbol <> '' THEN @quote_symbol ELSE quote_symbol END,
    source = CASE WHEN @source <> '' THEN @source ELSE source END,
    stage = CASE WHEN @stage <> '' THEN @stage ELSE stage END,
    block_number = COALESCE(block_number, @block_number),
    tx_hash = CASE WHEN tx_hash = '' AND @tx_hash <> '' THEN @tx_hash ELSE tx_hash END,
    creator_address = CASE WHEN creator_address = '' AND @creator_address <> '' THEN @creator_address ELSE creator_address END,
    raw_payload = @raw_payload,
    updated_at = @updated_at
  WHERE pool_key = @pool_key
`;

export function persistDiscoveryEvent(event = {}) {
  const tokenAddress = lc(event.tokenCa || event.token_address);
  if (!/^0x[a-f0-9]{40}$/.test(tokenAddress)) {
    return { ok: false, skipped: true, reason: 'invalid_token_address' };
  }

  const now = new Date().toISOString();
  const firstSeen = txt(event.firstSeen || event.event_time) || now;
  const source = txt(event.source);
  const stage = txt(event.stage);
  const poolKey = poolKeyFor(event);
  const poolVersion = /v4/i.test(stage) || /v4/i.test(txt(event.pairType)) ? 'V4'
    : /v3/i.test(stage) || /v3/i.test(txt(event.pairType)) ? 'V3'
    : /pons/i.test(source) ? 'Curve' : txt(event.pairType);
  const rawPayload = safeJson(event);

  const tokenRow = {
    token_address: tokenAddress,
    symbol: txt(event.symbol),
    creator_address: lc(event.deployer || event.creator_address),
    first_seen_at: firstSeen,
    last_seen_at: txt(event.lastUpdate) || now,
    first_source: source,
    stage,
    discovery_tx: lc(event.txHash || event.discovery_tx),
    discovery_block: Number.isFinite(Number(event.block || event.block_number)) ? Number(event.block || event.block_number) : null,
    raw_payload: rawPayload,
    created_at: now,
    updated_at: now,
  };

  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare(upsertTokenSql).run(tokenRow);
    let poolInserted = false;

    if (poolKey) {
      const isAddress = /^0x[a-f0-9]{40}$/.test(poolKey);
      const poolRow = {
        pool_key: poolKey,
        pool_address: isAddress ? poolKey : '',
        token_address: tokenAddress,
        dex: source,
        pool_version: poolVersion,
        quote_token: lc(event.pairToken || event.quote_token),
        quote_symbol: txt(event.quoteSymbol || event.quote_symbol),
        source,
        stage,
        discovered_at: firstSeen,
        block_number: tokenRow.discovery_block,
        tx_hash: tokenRow.discovery_tx,
        creator_address: tokenRow.creator_address,
        raw_payload: rawPayload,
        created_at: now,
        updated_at: now,
      };
      const inserted = db.prepare(insertPoolSql).run(poolRow);
      poolInserted = inserted.changes > 0;
      db.prepare(updatePoolSql).run(poolRow);

      if (poolInserted) {
        db.prepare(`
          UPDATE tokens SET
            pool_count = pool_count + 1,
            first_pool_key = CASE WHEN first_pool_key = '' THEN ? ELSE first_pool_key END,
            updated_at = ?
          WHERE token_address = ?
        `).run(poolKey, now, tokenAddress);
      }
    }

    return { ok: true, tokenAddress, poolKey, poolInserted };
  });

  return tx();
}

export function getDatabaseHealth() {
  const db = getDatabase();
  const tokens = Number(db.prepare('SELECT COUNT(*) AS n FROM tokens').get()?.n || 0);
  const pools = Number(db.prepare('SELECT COUNT(*) AS n FROM pools').get()?.n || 0);
  const latest = db.prepare('SELECT MAX(updated_at) AS ts FROM tokens').get()?.ts || null;
  return { dbPath: DB_PATH, dbTokens: tokens, dbPools: pools, dbLastWriteAt: latest };
}

export function closeDatabase() {
  if (!sharedDb) return;
  sharedDb.close();
  sharedDb = null;
}
