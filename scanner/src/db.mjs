import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.SQLITE_PATH || '/data/rh_monitor.db';
export const REALTIME_OPPORTUNITY_MAX_AGE_MS = Math.max(60_000, Number(process.env.REALTIME_OPPORTUNITY_MAX_AGE_MS || 250_000));
let sharedDb = null;

function ensureParentDir() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

function configure(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 30000');
  db.pragma('foreign_keys = ON');
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  } catch {
    return '{}';
  }
}

function parseJson(value) {
  try { return JSON.parse(String(value || '{}')); }
  catch { return {}; }
}

function txt(v) {
  return v == null ? '' : String(v).trim();
}

function lc(v) {
  return txt(v).toLowerCase();
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function poolKeyFor(event) {
  const pool = txt(event.pool);
  if (!pool) return '';
  return lc(pool);
}

function pctChange(current, initial) {
  const a = num(current), b = num(initial);
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

function eventTimestampMs(event = {}) {
  for (const value of [event.firstSeen, event.event_time, event.chainTime]) {
    const t = new Date(value || '').getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function isRealtimeDiscoveryEvent(event = {}, nowMs = Date.now(), maxAgeMs = REALTIME_OPPORTUNITY_MAX_AGE_MS) {
  const eventMs = eventTimestampMs(event);
  if (!Number.isFinite(eventMs)) return false;
  return Math.max(0, nowMs - eventMs) <= maxAgeMs;
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

    CREATE TABLE IF NOT EXISTS jobs (
      job_id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      job_type TEXT NOT NULL,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 4,
      last_error TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_key TEXT NOT NULL UNIQUE,
      job_id INTEGER,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      snapshot_type TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      price_usd REAL,
      market_cap REAL,
      fdv REAL,
      liquidity_usd REAL,
      buy_count INTEGER,
      sell_count INTEGER,
      buy_volume_usd REAL,
      sell_volume_usd REAL,
      volume_total_usd REAL,
      holder_count INTEGER,
      price_change_pct REAL,
      market_cap_change_pct REAL,
      liquidity_change_pct REAL,
      dex TEXT NOT NULL DEFAULT '',
      pair_address TEXT NOT NULL DEFAULT '',
      source_status TEXT NOT NULL DEFAULT '',
      raw_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(job_id),
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE INDEX IF NOT EXISTS idx_pools_token_address ON pools(token_address);
    CREATE INDEX IF NOT EXISTS idx_pools_discovered_at ON pools(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_pools_tx_hash ON pools(tx_hash);
    CREATE INDEX IF NOT EXISTS idx_tokens_first_seen_at ON tokens(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_token ON jobs(token_address, job_type);
    CREATE INDEX IF NOT EXISTS idx_snapshots_token ON snapshots(token_address, snapshot_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots(snapshot_type, snapshot_at);
  `);
  const currentVersion = Number(db.pragma('user_version', { simple: true }) || 0);
  if (currentVersion < 4) db.pragma('user_version = 4');
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

function scheduleJobs(db, event, tokenAddress, poolKey, now) {
  const stage = txt(event.stage);
  if (!/(TokenLaunched|PoolInitialized|PoolCreated|Discovery)/i.test(stage)) return 0;
  const anchor = poolKey || lc(event.txHash || event.discovery_tx) || tokenAddress;
  const specs = [
    ['ENRICH_INITIAL', 15_000],
    ['SNAPSHOT_1M', 60_000],
  ];
  let created = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs (
      dedupe_key, token_address, pool_key, job_type, run_at, status,
      retry_count, max_retries, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 4, ?, ?, ?)
  `);
  const nowMs = new Date(now).getTime();
  const eventMs = eventTimestampMs(event);
  const eventAgeMs = Number.isFinite(eventMs) ? Math.max(0, nowMs - eventMs) : null;
  const replay = !isRealtimeDiscoveryEvent(event, nowMs);
  const payload = safeJson({
    ...event,
    _monitorMeta: { replay, eventAgeMs, realtimeMaxAgeMs: REALTIME_OPPORTUNITY_MAX_AGE_MS },
  });
  for (const [jobType, delayMs] of specs) {
    const runAt = new Date(Date.now() + delayMs).toISOString();
    const result = stmt.run(
      `${jobType}:${tokenAddress}:${anchor}`,
      tokenAddress,
      poolKey,
      jobType,
      runAt,
      payload,
      now,
      now,
    );
    created += result.changes;
  }
  return created;
}

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

    const jobsCreated = scheduleJobs(db, event, tokenAddress, poolKey, now);
    return { ok: true, tokenAddress, poolKey, poolInserted, jobsCreated };
  });

  return tx();
}

let lastStaleRecoveryAt = 0;
const STALE_RECOVERY_INTERVAL_MS = 60_000;

export function claimDueJob() {
  const db = getDatabase();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const recoverStale = nowMs - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS;

  const tx = db.transaction(() => {
    if (recoverStale) {
      const stale = new Date(nowMs - 10 * 60_000).toISOString();
      db.prepare(`
        UPDATE jobs SET status='PENDING', started_at=NULL, updated_at=?
        WHERE status='RUNNING' AND started_at IS NOT NULL AND started_at < ? AND retry_count < max_retries
      `).run(now, stale);
    }

    const liveCutoff = new Date(nowMs - REALTIME_OPPORTUNITY_MAX_AGE_MS).toISOString();
    const row = db.prepare(`
      SELECT * FROM jobs
      WHERE status='PENDING'
        AND run_at <= ?
        AND job_type IN ('ENRICH_INITIAL','SNAPSHOT_1M')
      ORDER BY
        CASE WHEN julianday(COALESCE(
          json_extract(payload,'$.firstSeen'),
          json_extract(payload,'$.event_time'),
          json_extract(payload,'$.chainTime'),
          created_at
        )) >= julianday(?) THEN 0 ELSE 1 END ASC,
        run_at ASC, job_id ASC
      LIMIT 1
    `).get(now, liveCutoff);
    if (!row) return null;

    const claimed = db.prepare(`
      UPDATE jobs SET status='RUNNING', started_at=?, updated_at=?
      WHERE job_id=? AND status='PENDING'
    `).run(now, now, row.job_id);
    if (!claimed.changes) return null;
    return { ...row, payload: parseJson(row.payload) };
  });

  const result = tx();
  if (recoverStale) lastStaleRecoveryAt = nowMs;
  return result;
}

export function completeJob(jobId) {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(`
    UPDATE jobs SET status='DONE', finished_at=?, updated_at=?, last_error=''
    WHERE job_id=?
  `).run(now, now, jobId);
  return result.changes > 0;
}

export function failJob(jobId, error) {
  const db = getDatabase();
  const row = db.prepare('SELECT retry_count, max_retries FROM jobs WHERE job_id=?').get(jobId);
  if (!row) return { ok: false, reason: 'job_not_found' };
  const retryCount = Number(row.retry_count || 0) + 1;
  const failed = retryCount >= Number(row.max_retries || 4);
  const delayMs = Math.min(60_000, 5_000 * (2 ** Math.max(0, retryCount - 1)));
  const now = new Date().toISOString();
  const runAt = new Date(Date.now() + delayMs).toISOString();
  db.prepare(`
    UPDATE jobs SET
      status=?, retry_count=?, last_error=?, run_at=?, started_at=NULL,
      finished_at=CASE WHEN ?='FAILED' THEN ? ELSE NULL END,
      updated_at=?
    WHERE job_id=?
  `).run(
    failed ? 'FAILED' : 'PENDING',
    retryCount,
    txt(error).slice(0, 1000),
    runAt,
    failed ? 'FAILED' : 'PENDING',
    now,
    now,
    jobId,
  );
  return { ok: true, failed, retryCount, runAt };
}

export function updateTokenEnrichment(tokenAddress, data = {}) {
  const token = lc(tokenAddress);
  const now = new Date().toISOString();
  getDatabase().prepare(`
    UPDATE tokens SET
      symbol = CASE WHEN ? <> '' THEN ? ELSE symbol END,
      name = CASE WHEN ? <> '' THEN ? ELSE name END,
      decimals = COALESCE(?, decimals),
      total_supply = CASE WHEN ? <> '' THEN ? ELSE total_supply END,
      last_seen_at = ?,
      updated_at = ?
    WHERE token_address = ?
  `).run(
    txt(data.symbol), txt(data.symbol),
    txt(data.name), txt(data.name),
    Number.isFinite(Number(data.decimals)) ? Number(data.decimals) : null,
    txt(data.totalSupply), txt(data.totalSupply),
    now, now, token,
  );
}

export function saveSnapshot(job, data = {}) {
  const db = getDatabase();
  const tokenAddress = lc(job.token_address);
  const poolKey = lc(job.pool_key || job.payload?.pool || '');
  const snapshotType = job.job_type === 'SNAPSHOT_1M' ? '1M' : 'INITIAL';
  const snapshotAt = new Date().toISOString();
  const initial = snapshotType === '1M'
    ? db.prepare(`
        SELECT price_usd, market_cap, liquidity_usd
        FROM snapshots
        WHERE token_address=? AND snapshot_type='INITIAL'
        ORDER BY snapshot_at DESC LIMIT 1
      `).get(tokenAddress)
    : null;

  const row = {
    snapshot_key: `${job.job_id}:${snapshotType}`,
    job_id: Number(job.job_id),
    token_address: tokenAddress,
    pool_key: poolKey,
    snapshot_type: snapshotType,
    snapshot_at: snapshotAt,
    price_usd: num(data.priceUsd),
    market_cap: num(data.marketCap),
    fdv: num(data.fdv),
    liquidity_usd: num(data.liquidityUsd),
    buy_count: num(data.buyCount),
    sell_count: num(data.sellCount),
    buy_volume_usd: num(data.buyVolumeUsd),
    sell_volume_usd: num(data.sellVolumeUsd),
    volume_total_usd: num(data.volumeTotalUsd),
    holder_count: num(data.holderCount),
    price_change_pct: pctChange(data.priceUsd, initial?.price_usd),
    market_cap_change_pct: pctChange(data.marketCap, initial?.market_cap),
    liquidity_change_pct: pctChange(data.liquidityUsd, initial?.liquidity_usd),
    dex: txt(data.dex),
    pair_address: lc(data.pairAddress),
    source_status: txt(data.sourceStatus),
    raw_data: safeJson(data.raw || data),
    created_at: snapshotAt,
  };

  db.prepare(`
    INSERT INTO snapshots (
      snapshot_key, job_id, token_address, pool_key, snapshot_type, snapshot_at,
      price_usd, market_cap, fdv, liquidity_usd, buy_count, sell_count,
      buy_volume_usd, sell_volume_usd, volume_total_usd, holder_count,
      price_change_pct, market_cap_change_pct, liquidity_change_pct,
      dex, pair_address, source_status, raw_data, created_at
    ) VALUES (
      @snapshot_key, @job_id, @token_address, @pool_key, @snapshot_type, @snapshot_at,
      @price_usd, @market_cap, @fdv, @liquidity_usd, @buy_count, @sell_count,
      @buy_volume_usd, @sell_volume_usd, @volume_total_usd, @holder_count,
      @price_change_pct, @market_cap_change_pct, @liquidity_change_pct,
      @dex, @pair_address, @source_status, @raw_data, @created_at
    )
    ON CONFLICT(snapshot_key) DO UPDATE SET
      snapshot_at=excluded.snapshot_at,
      price_usd=excluded.price_usd,
      market_cap=excluded.market_cap,
      fdv=excluded.fdv,
      liquidity_usd=excluded.liquidity_usd,
      buy_count=excluded.buy_count,
      sell_count=excluded.sell_count,
      buy_volume_usd=excluded.buy_volume_usd,
      sell_volume_usd=excluded.sell_volume_usd,
      volume_total_usd=excluded.volume_total_usd,
      holder_count=excluded.holder_count,
      price_change_pct=excluded.price_change_pct,
      market_cap_change_pct=excluded.market_cap_change_pct,
      liquidity_change_pct=excluded.liquidity_change_pct,
      dex=excluded.dex,
      pair_address=excluded.pair_address,
      source_status=excluded.source_status,
      raw_data=excluded.raw_data
  `).run(row);
  return row;
}

export function getDatabaseHealth() {
  const db = getDatabase();
  const tokens = Number(db.prepare('SELECT COUNT(*) AS n FROM tokens').get()?.n || 0);
  const pools = Number(db.prepare('SELECT COUNT(*) AS n FROM pools').get()?.n || 0);
  const snapshots = Number(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()?.n || 0);
  const pendingJobs = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='PENDING'").get()?.n || 0);
  const runningJobs = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='RUNNING'").get()?.n || 0);
  const failedJobs = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='FAILED'").get()?.n || 0);
  const latest = db.prepare('SELECT MAX(updated_at) AS ts FROM tokens').get()?.ts || null;
  const latestSnapshot = db.prepare('SELECT MAX(snapshot_at) AS ts FROM snapshots').get()?.ts || null;
  return {
    dbPath: DB_PATH,
    dbTokens: tokens,
    dbPools: pools,
    dbSnapshots: snapshots,
    dbPendingJobs: pendingJobs,
    dbRunningJobs: runningJobs,
    dbFailedJobs: failedJobs,
    dbLastWriteAt: latest,
    dbLastSnapshotAt: latestSnapshot,
  };
}

export function closeDatabase() {
  if (!sharedDb) return;
  sharedDb.close();
  sharedDb = null;
}
