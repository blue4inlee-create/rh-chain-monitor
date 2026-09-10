import { getDatabase } from './db.mjs';

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}
function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function text(v) {
  return v == null ? '' : String(v).trim();
}

export function ensureAthSchema() {
  const db = getDatabase();
  for (const definition of [
    'current_price_usd REAL',
    'current_market_cap REAL',
    'current_liquidity_usd REAL',
    'current_price_at TEXT',
    'ath_price_usd REAL',
    'ath_price_at TEXT',
    'ath_market_cap REAL',
    'ath_market_cap_at TEXT',
    'max_multiple_discovery REAL',
    'canary_ath_price_usd REAL',
    'canary_ath_at TEXT',
    'max_multiple_canary REAL'
  ]) addColumn(db, 'tokens', definition);

  db.exec(`
    CREATE TABLE IF NOT EXISTS market_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      tick_at TEXT NOT NULL,
      price_usd REAL,
      market_cap REAL,
      liquidity_usd REAL,
      buy_count_5m INTEGER,
      sell_count_5m INTEGER,
      volume_5m REAL,
      source TEXT NOT NULL DEFAULT '',
      raw_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_market_ticks_token_at
      ON market_ticks(token_address, tick_at DESC);
  `);

  backfillAthFromSnapshots(db);
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < 9) db.pragma('user_version = 9');
  return getAthHealth();
}

function backfillAthFromSnapshots(db) {
  db.exec(`
    UPDATE tokens
    SET current_price_usd = COALESCE(current_price_usd,
          (SELECT s.price_usd FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.price_usd IS NOT NULL
           ORDER BY s.snapshot_at DESC, s.id DESC LIMIT 1)),
        current_market_cap = COALESCE(current_market_cap,
          (SELECT s.market_cap FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.market_cap IS NOT NULL
           ORDER BY s.snapshot_at DESC, s.id DESC LIMIT 1)),
        current_liquidity_usd = COALESCE(current_liquidity_usd,
          (SELECT s.liquidity_usd FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.liquidity_usd IS NOT NULL
           ORDER BY s.snapshot_at DESC, s.id DESC LIMIT 1)),
        current_price_at = COALESCE(current_price_at,
          (SELECT s.snapshot_at FROM snapshots s
           WHERE s.token_address=tokens.token_address
             AND (s.price_usd IS NOT NULL OR s.market_cap IS NOT NULL)
           ORDER BY s.snapshot_at DESC, s.id DESC LIMIT 1)),
        ath_price_usd = COALESCE(ath_price_usd,
          (SELECT MAX(s.price_usd) FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.price_usd IS NOT NULL)),
        ath_market_cap = COALESCE(ath_market_cap,
          (SELECT MAX(s.market_cap) FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.market_cap IS NOT NULL))
    WHERE EXISTS (SELECT 1 FROM snapshots s WHERE s.token_address=tokens.token_address);

    UPDATE tokens
    SET ath_price_at = COALESCE(ath_price_at,
          (SELECT s.snapshot_at FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.price_usd=ath_price_usd
           ORDER BY s.snapshot_at ASC, s.id ASC LIMIT 1)),
        ath_market_cap_at = COALESCE(ath_market_cap_at,
          (SELECT s.snapshot_at FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.market_cap=ath_market_cap
           ORDER BY s.snapshot_at ASC, s.id ASC LIMIT 1)),
        max_multiple_discovery = CASE
          WHEN discovery_price_usd > 0 AND ath_price_usd IS NOT NULL
            THEN MAX(COALESCE(max_multiple_discovery, 0), ath_price_usd / discovery_price_usd)
          ELSE max_multiple_discovery END;

    UPDATE tokens
    SET canary_ath_price_usd = COALESCE(canary_ath_price_usd,
          (SELECT MAX(s.price_usd) FROM snapshots s
           WHERE s.token_address=tokens.token_address
             AND tokens.canary_at IS NOT NULL
             AND s.snapshot_at >= tokens.canary_at
             AND s.price_usd IS NOT NULL))
    WHERE canary_at IS NOT NULL;

    UPDATE tokens
    SET canary_ath_price_usd = COALESCE(canary_ath_price_usd, canary_price_usd),
        canary_ath_at = COALESCE(canary_ath_at,
          (SELECT s.snapshot_at FROM snapshots s
           WHERE s.token_address=tokens.token_address
             AND s.snapshot_at >= tokens.canary_at
             AND s.price_usd=canary_ath_price_usd
           ORDER BY s.snapshot_at ASC, s.id ASC LIMIT 1),
          canary_at),
        max_multiple_canary = CASE
          WHEN canary_price_usd > 0 AND COALESCE(canary_ath_price_usd, canary_price_usd) IS NOT NULL
            THEN MAX(COALESCE(max_multiple_canary, 0), COALESCE(canary_ath_price_usd, canary_price_usd) / canary_price_usd)
          ELSE max_multiple_canary END
    WHERE canary_at IS NOT NULL;
  `);
}

export function recordMarketTick(data = {}) {
  const db = getDatabase();
  const token = text(data.tokenAddress).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return { ok: false, reason: 'invalid_token' };
  const at = text(data.tickAt) || new Date().toISOString();
  const bucket = Math.floor(new Date(at).getTime() / 60_000);
  const row = {
    tick_key: `${token}:${bucket}`,
    token_address: token,
    pool_key: text(data.poolKey).toLowerCase(),
    tick_at: at,
    price_usd: num(data.priceUsd),
    market_cap: num(data.marketCap),
    liquidity_usd: num(data.liquidityUsd),
    buy_count_5m: num(data.buyCount5m),
    sell_count_5m: num(data.sellCount5m),
    volume_5m: num(data.volume5m),
    source: text(data.source),
    raw_data: (() => { try { return JSON.stringify(data.raw || {}); } catch { return '{}'; } })(),
    created_at: at,
  };

  return db.transaction(() => {
    db.prepare(`
      INSERT INTO market_ticks (
        tick_key, token_address, pool_key, tick_at, price_usd, market_cap,
        liquidity_usd, buy_count_5m, sell_count_5m, volume_5m,
        source, raw_data, created_at
      ) VALUES (
        @tick_key, @token_address, @pool_key, @tick_at, @price_usd, @market_cap,
        @liquidity_usd, @buy_count_5m, @sell_count_5m, @volume_5m,
        @source, @raw_data, @created_at
      )
      ON CONFLICT(tick_key) DO UPDATE SET
        tick_at=excluded.tick_at,
        price_usd=COALESCE(excluded.price_usd, market_ticks.price_usd),
        market_cap=COALESCE(excluded.market_cap, market_ticks.market_cap),
        liquidity_usd=COALESCE(excluded.liquidity_usd, market_ticks.liquidity_usd),
        buy_count_5m=COALESCE(excluded.buy_count_5m, market_ticks.buy_count_5m),
        sell_count_5m=COALESCE(excluded.sell_count_5m, market_ticks.sell_count_5m),
        volume_5m=COALESCE(excluded.volume_5m, market_ticks.volume_5m),
        source=CASE WHEN excluded.source<>'' THEN excluded.source ELSE market_ticks.source END,
        raw_data=excluded.raw_data
    `).run(row);

    const tokenRow = db.prepare(`
      SELECT discovery_price_usd, canary_price_usd, canary_at,
             ath_price_usd, ath_market_cap, canary_ath_price_usd,
             max_multiple_discovery, max_multiple_canary
      FROM tokens WHERE token_address=?
    `).get(token);
    if (!tokenRow) return { ok: false, reason: 'token_not_found' };

    const price = row.price_usd;
    const mc = row.market_cap;
    const afterCanary = tokenRow.canary_at && at >= tokenRow.canary_at;
    const newAthPrice = price != null && (tokenRow.ath_price_usd == null || price > tokenRow.ath_price_usd);
    const newAthMc = mc != null && (tokenRow.ath_market_cap == null || mc > tokenRow.ath_market_cap);
    const newCanaryAth = afterCanary && price != null && (tokenRow.canary_ath_price_usd == null || price > tokenRow.canary_ath_price_usd);
    const discoveryMultiple = price != null && Number(tokenRow.discovery_price_usd) > 0
      ? price / Number(tokenRow.discovery_price_usd) : null;
    const canaryMultiple = afterCanary && price != null && Number(tokenRow.canary_price_usd) > 0
      ? price / Number(tokenRow.canary_price_usd) : null;

    db.prepare(`
      UPDATE tokens SET
        current_price_usd=COALESCE(?, current_price_usd),
        current_market_cap=COALESCE(?, current_market_cap),
        current_liquidity_usd=COALESCE(?, current_liquidity_usd),
        current_price_at=?,
        ath_price_usd=CASE WHEN ? THEN ? ELSE ath_price_usd END,
        ath_price_at=CASE WHEN ? THEN ? ELSE ath_price_at END,
        ath_market_cap=CASE WHEN ? THEN ? ELSE ath_market_cap END,
        ath_market_cap_at=CASE WHEN ? THEN ? ELSE ath_market_cap_at END,
        canary_ath_price_usd=CASE WHEN ? THEN ? ELSE canary_ath_price_usd END,
        canary_ath_at=CASE WHEN ? THEN ? ELSE canary_ath_at END,
        max_multiple_discovery=CASE
          WHEN ? IS NOT NULL THEN MAX(COALESCE(max_multiple_discovery,0), ?)
          ELSE max_multiple_discovery END,
        max_multiple_canary=CASE
          WHEN ? IS NOT NULL THEN MAX(COALESCE(max_multiple_canary,0), ?)
          ELSE max_multiple_canary END,
        updated_at=?
      WHERE token_address=?
    `).run(
      price, mc, row.liquidity_usd, at,
      newAthPrice ? 1 : 0, price, newAthPrice ? 1 : 0, at,
      newAthMc ? 1 : 0, mc, newAthMc ? 1 : 0, at,
      newCanaryAth ? 1 : 0, price, newCanaryAth ? 1 : 0, at,
      discoveryMultiple, discoveryMultiple,
      canaryMultiple, canaryMultiple,
      at, token,
    );

    return {
      ok: true,
      token,
      price,
      marketCap: mc,
      newAthPrice,
      newAthMc,
      newCanaryAth,
      discoveryMultiple,
      canaryMultiple,
    };
  })();
}

export function getAthHealth() {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS tokens,
      SUM(CASE WHEN ath_price_usd IS NOT NULL THEN 1 ELSE 0 END) AS ath_priced,
      SUM(CASE WHEN canary_at IS NOT NULL THEN 1 ELSE 0 END) AS canaries,
      SUM(CASE WHEN canary_ath_price_usd IS NOT NULL THEN 1 ELSE 0 END) AS canary_ath_priced,
      SUM(CASE WHEN max_multiple_canary IS NOT NULL THEN 1 ELSE 0 END) AS canary_multiples,
      MAX(max_multiple_canary) AS best_canary_multiple,
      MAX(current_price_at) AS latest_tick_at
    FROM tokens
  `).get() || {};
  const ticks = Number(db.prepare('SELECT COUNT(*) AS n FROM market_ticks').get()?.n || 0);
  return {
    tokens: Number(row.tokens || 0),
    athPriced: Number(row.ath_priced || 0),
    canaries: Number(row.canaries || 0),
    canaryAthPriced: Number(row.canary_ath_priced || 0),
    canaryMultiples: Number(row.canary_multiples || 0),
    bestCanaryMultiple: num(row.best_canary_multiple),
    marketTicks: ticks,
    latestTickAt: row.latest_tick_at || null,
  };
}
