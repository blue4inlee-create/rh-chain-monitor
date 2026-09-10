import { getDatabase } from './db.mjs';

function text(v) { return v == null ? '' : String(v).trim(); }
function lc(v) { return text(v).toLowerCase(); }
function validAddress(v) { return /^0x[a-f0-9]{40}$/.test(lc(v)); }
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}

export function ensureCurveFirstSwapSchema() {
  const db = getDatabase();
  if (!hasColumn(db, 'tokens', 'first_swap_at')) db.exec('ALTER TABLE tokens ADD COLUMN first_swap_at TEXT');
  if (!hasColumn(db, 'tokens', 'first_swap_tx')) db.exec("ALTER TABLE tokens ADD COLUMN first_swap_tx TEXT NOT NULL DEFAULT ''");
  if (!hasColumn(db, 'tokens', 'first_swap_direction')) db.exec("ALTER TABLE tokens ADD COLUMN first_swap_direction TEXT NOT NULL DEFAULT ''");
  if (!hasColumn(db, 'tokens', 'first_swap_block')) db.exec('ALTER TABLE tokens ADD COLUMN first_swap_block INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS curve_first_swaps (
      token_address TEXT PRIMARY KEY,
      curve_address TEXT NOT NULL,
      direction TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER,
      chain_time TEXT,
      detected_at TEXT NOT NULL,
      launch_at TEXT,
      launch_to_swap_sec REAL,
      raw_payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_curve_first_swaps_curve ON curve_first_swaps(curve_address);
    CREATE INDEX IF NOT EXISTS idx_curve_first_swaps_detected ON curve_first_swaps(detected_at);
  `);
}

export function loadPendingCurveRegistry(limit = 5000) {
  ensureCurveFirstSwapSchema();
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT p.pool_address AS curve_address, p.pool_key, p.token_address,
           p.discovered_at AS launch_at, p.block_number AS launch_block,
           p.quote_token, t.first_swap_tx
    FROM pools p
    JOIN tokens t ON t.token_address=p.token_address
    WHERE p.pool_version='Curve'
      AND COALESCE(t.first_swap_tx, '')=''
      AND p.pool_address <> ''
    ORDER BY p.discovered_at DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 5000));
  return rows.filter(r => validAddress(r.curve_address) && validAddress(r.token_address));
}

export function persistCurveFirstSwap(event = {}) {
  ensureCurveFirstSwapSchema();
  const db = getDatabase();
  const token = lc(event.tokenCa || event.token_address);
  const curve = lc(event.pool || event.curve_address);
  const txHash = lc(event.txHash || event.tx_hash);
  if (!validAddress(token) || !validAddress(curve) || !/^0x[a-f0-9]{64}$/.test(txHash)) {
    return { ok:false, skipped:true, reason:'invalid_identity' };
  }
  const detectedAt = text(event.detectedAt || event.lastUpdate) || new Date().toISOString();
  const chainTime = text(event.chainTime || event.event_time) || null;
  const launchAt = text(event.launchAt) || null;
  const launchMs = launchAt ? Date.parse(launchAt) : NaN;
  const swapMs = chainTime ? Date.parse(chainTime) : NaN;
  const launchToSwapSec = Number.isFinite(launchMs) && Number.isFinite(swapMs) ? Math.max(0, (swapMs - launchMs) / 1000) : null;
  const now = new Date().toISOString();
  const payload = JSON.stringify(event, (_, v) => typeof v === 'bigint' ? v.toString() : v);

  return db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO curve_first_swaps (
        token_address, curve_address, direction, tx_hash, block_number,
        chain_time, detected_at, launch_at, launch_to_swap_sec, raw_payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token, curve, text(event.direction), txHash,
      Number.isFinite(Number(event.block || event.block_number)) ? Number(event.block || event.block_number) : null,
      chainTime, detectedAt, launchAt, launchToSwapSec, payload, now,
    );
    if (inserted.changes) {
      db.prepare(`
        UPDATE tokens SET
          first_swap_at=COALESCE(first_swap_at, ?),
          first_swap_tx=CASE WHEN first_swap_tx='' THEN ? ELSE first_swap_tx END,
          first_swap_direction=CASE WHEN first_swap_direction='' THEN ? ELSE first_swap_direction END,
          first_swap_block=COALESCE(first_swap_block, ?),
          last_seen_at=?, updated_at=?
        WHERE token_address=?
      `).run(
        chainTime || detectedAt, txHash, text(event.direction),
        Number.isFinite(Number(event.block || event.block_number)) ? Number(event.block || event.block_number) : null,
        detectedAt, now, token,
      );
    }
    return { ok:true, inserted:inserted.changes > 0, tokenAddress:token, curveAddress:curve, launchToSwapSec };
  })();
}

export function getCurveFirstSwapHealth() {
  ensureCurveFirstSwapSchema();
  const db = getDatabase();
  const captured = Number(db.prepare('SELECT COUNT(*) AS n FROM curve_first_swaps').get()?.n || 0);
  const latest = db.prepare(`SELECT token_address, curve_address, direction, tx_hash, block_number, chain_time, detected_at, launch_at, launch_to_swap_sec FROM curve_first_swaps ORDER BY detected_at DESC LIMIT 1`).get() || null;
  return { captured, latest };
}
