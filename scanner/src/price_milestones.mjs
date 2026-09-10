import { getDatabase } from './db.mjs';

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function ensurePriceMilestoneSchema() {
  const db = getDatabase();
  addColumn(db, 'tokens', 'discovery_price_usd REAL');
  addColumn(db, 'tokens', 'discovery_market_cap REAL');
  addColumn(db, 'tokens', 'discovery_price_at TEXT');
  addColumn(db, 'tokens', 'canary_price_usd REAL');
  addColumn(db, 'tokens', 'canary_market_cap REAL');
  addColumn(db, 'tokens', 'canary_at TEXT');

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_snapshots_capture_discovery_price
    AFTER INSERT ON snapshots
    WHEN NEW.price_usd IS NOT NULL OR NEW.market_cap IS NOT NULL
    BEGIN
      UPDATE tokens
      SET discovery_price_usd = COALESCE(discovery_price_usd, NEW.price_usd),
          discovery_market_cap = COALESCE(discovery_market_cap, NEW.market_cap),
          discovery_price_at = CASE
            WHEN discovery_price_at IS NULL AND (NEW.price_usd IS NOT NULL OR NEW.market_cap IS NOT NULL)
              THEN NEW.snapshot_at
            ELSE discovery_price_at
          END,
          updated_at = CASE
            WHEN discovery_price_usd IS NULL OR discovery_market_cap IS NULL THEN NEW.snapshot_at
            ELSE updated_at
          END
      WHERE token_address = NEW.token_address;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_stage_capture_canary_price
    AFTER INSERT ON stage_history
    WHEN NEW.to_stage = 'CANARY'
    BEGIN
      UPDATE tokens
      SET canary_price_usd = COALESCE(canary_price_usd, NEW.price_at_change),
          canary_market_cap = COALESCE(canary_market_cap, NEW.market_cap_at_change),
          canary_at = COALESCE(canary_at, NEW.changed_at),
          updated_at = NEW.changed_at
      WHERE token_address = NEW.token_address;
    END;
  `);

  db.exec(`
    UPDATE tokens
    SET discovery_price_usd = COALESCE(
          discovery_price_usd,
          (SELECT s.price_usd FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.price_usd IS NOT NULL
           ORDER BY s.snapshot_at ASC, s.id ASC LIMIT 1)
        ),
        discovery_market_cap = COALESCE(
          discovery_market_cap,
          (SELECT s.market_cap FROM snapshots s
           WHERE s.token_address=tokens.token_address AND s.market_cap IS NOT NULL
           ORDER BY s.snapshot_at ASC, s.id ASC LIMIT 1)
        ),
        discovery_price_at = COALESCE(
          discovery_price_at,
          (SELECT s.snapshot_at FROM snapshots s
           WHERE s.token_address=tokens.token_address
             AND (s.price_usd IS NOT NULL OR s.market_cap IS NOT NULL)
           ORDER BY s.snapshot_at ASC, s.id ASC LIMIT 1)
        )
    WHERE discovery_price_usd IS NULL OR discovery_market_cap IS NULL OR discovery_price_at IS NULL;

    UPDATE tokens
    SET canary_price_usd = COALESCE(
          canary_price_usd,
          (SELECT h.price_at_change FROM stage_history h
           WHERE h.token_address=tokens.token_address AND h.to_stage='CANARY'
             AND h.price_at_change IS NOT NULL
           ORDER BY h.changed_at ASC, h.id ASC LIMIT 1)
        ),
        canary_market_cap = COALESCE(
          canary_market_cap,
          (SELECT h.market_cap_at_change FROM stage_history h
           WHERE h.token_address=tokens.token_address AND h.to_stage='CANARY'
             AND h.market_cap_at_change IS NOT NULL
           ORDER BY h.changed_at ASC, h.id ASC LIMIT 1)
        ),
        canary_at = COALESCE(
          canary_at,
          (SELECT h.changed_at FROM stage_history h
           WHERE h.token_address=tokens.token_address AND h.to_stage='CANARY'
           ORDER BY h.changed_at ASC, h.id ASC LIMIT 1)
        )
    WHERE canary_price_usd IS NULL OR canary_market_cap IS NULL OR canary_at IS NULL;
  `);

  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < 8) db.pragma('user_version = 8');
  return getPriceMilestoneHealth();
}

export function getPriceMilestoneHealth() {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS tokens,
      SUM(CASE WHEN discovery_price_usd IS NOT NULL THEN 1 ELSE 0 END) AS discovery_priced,
      SUM(CASE WHEN canary_at IS NOT NULL THEN 1 ELSE 0 END) AS canary_entries,
      SUM(CASE WHEN canary_at IS NOT NULL AND canary_price_usd IS NOT NULL THEN 1 ELSE 0 END) AS canary_priced,
      MAX(discovery_price_at) AS latest_discovery_price_at,
      MAX(canary_at) AS latest_canary_at
    FROM tokens
  `).get() || {};
  return {
    tokens: Number(row.tokens || 0),
    discoveryPriced: Number(row.discovery_priced || 0),
    canaryEntries: Number(row.canary_entries || 0),
    canaryPriced: Number(row.canary_priced || 0),
    latestDiscoveryPriceAt: row.latest_discovery_price_at || null,
    latestCanaryAt: row.latest_canary_at || null,
  };
}
