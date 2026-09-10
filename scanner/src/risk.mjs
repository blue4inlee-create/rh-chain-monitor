import { getDatabase } from './db.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = (process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase();
const USDG = (process.env.USDG || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168').toLowerCase();

function text(v) {
  return v == null ? '' : String(v).trim();
}
function lower(v) {
  return text(v).toLowerCase();
}
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeJson(v) {
  try { return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x); }
  catch { return '{}'; }
}

export function ensureRiskSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      risk_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      pool_key TEXT NOT NULL DEFAULT '',
      snapshot_type TEXT NOT NULL DEFAULT '',
      check_name TEXT NOT NULL,
      status TEXT NOT NULL,
      severity INTEGER NOT NULL DEFAULT 0,
      value TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL,
      raw_data TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_risk_token ON risk_checks(token_address, checked_at);
    CREATE INDEX IF NOT EXISTS idx_risk_status ON risk_checks(status, severity, checked_at);
  `);
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < 5) db.pragma('user_version = 5');
}

function check(name, status, severity, value, details, source) {
  return { name, status, severity, value: text(value), details: text(details), source: text(source) };
}

export function buildRiskChecks({ snapshot, chainMeta = {}, pons = {}, pairToken = '', sourceStatus = '' } = {}) {
  const checks = [];
  const token = lower(snapshot?.token_address);
  const quote = lower(pairToken || pons?.pairToken);
  const isPons = Boolean(pons?.isPons);
  const phase = isPons && pons?.phase != null ? Number(pons.phase) : null;
  const creatorTaxBps = isPons && pons?.creatorTaxBps != null ? Number(pons.creatorTaxBps) : null;
  const liquidity = num(snapshot?.liquidity_usd);
  const holders = num(snapshot?.holder_count);

  const metaOk = Boolean(text(chainMeta?.symbol) || text(chainMeta?.name) || text(chainMeta?.totalSupply));
  checks.push(check(
    'CONTRACT_METADATA',
    metaOk ? 'PASS' : 'UNKNOWN',
    metaOk ? 0 : 1,
    metaOk ? 'onchain-readable' : '',
    metaOk ? 'ERC20 metadata readable from RPC.' : 'ERC20 metadata could not be confirmed yet.',
    'onchain-rpc',
  ));

  checks.push(check(
    'LAUNCH_SOURCE',
    isPons ? 'PASS' : 'UNKNOWN',
    isPons ? 0 : 1,
    isPons ? 'Pons V2' : 'Direct/Other',
    isPons ? 'Launch is present in the configured Pons V2 factory.' : 'Direct pool source needs separate contract review.',
    isPons ? 'Pons V2 factory' : 'scanner',
  ));

  if (isPons) {
    let status = 'PASS', severity = 0, details = 'Pons token is in an active/created phase.';
    if (phase === 1) { status = 'WARN'; severity = 1; details = 'Pons token is in Swept transition phase.'; }
    if (phase === 3) { status = 'FAIL'; severity = 3; details = 'Pons token is in Rescued phase.'; }
    checks.push(check('PONS_PHASE', status, severity, phase, details, 'Pons V2 factory'));
  } else {
    checks.push(check('PONS_PHASE', 'UNKNOWN', 0, '', 'Not a confirmed Pons V2 launch.', 'scanner'));
  }

  if (creatorTaxBps == null) {
    checks.push(check('CREATOR_TAX', 'UNKNOWN', 1, '', 'Creator tax is not available for this source.', 'onchain'));
  } else if (creatorTaxBps >= 800) {
    checks.push(check('CREATOR_TAX', 'FAIL', 3, `${(creatorTaxBps / 100).toFixed(2)}%`, 'Creator tax is 8% or higher.', 'Pons V2 factory'));
  } else if (creatorTaxBps >= 300) {
    checks.push(check('CREATOR_TAX', 'WARN', 2, `${(creatorTaxBps / 100).toFixed(2)}%`, 'Creator tax is between 3% and 8%.', 'Pons V2 factory'));
  } else {
    checks.push(check('CREATOR_TAX', 'PASS', 0, `${(creatorTaxBps / 100).toFixed(2)}%`, 'Creator tax is below 3%.', 'Pons V2 factory'));
  }

  if (!quote || quote === ZERO || quote === WETH || quote === USDG) {
    const label = !quote || quote === ZERO ? 'ETH' : (quote === WETH ? 'WETH' : 'USDG');
    checks.push(check('PAIR_ASSET', 'PASS', 0, label, 'Pair asset is a configured base quote.', 'scanner'));
  } else {
    checks.push(check('PAIR_ASSET', 'UNKNOWN', 1, quote, 'Custom pair asset requires classification; it may be a stock token or another ERC20.', 'scanner'));
  }

  if (liquidity == null) {
    checks.push(check('DEX_LIQUIDITY', 'UNKNOWN', 1, '', 'DEX liquidity is not indexed yet; absence is not treated as safe or unsafe.', 'DexScreener'));
  } else if (liquidity < 2000) {
    checks.push(check('DEX_LIQUIDITY', 'WARN', 2, liquidity, 'Indexed DEX liquidity is below $2,000.', 'DexScreener'));
  } else if (liquidity < 10000) {
    checks.push(check('DEX_LIQUIDITY', 'WARN', 1, liquidity, 'Indexed DEX liquidity is below $10,000.', 'DexScreener'));
  } else {
    checks.push(check('DEX_LIQUIDITY', 'PASS', 0, liquidity, 'Indexed DEX liquidity is at least $10,000.', 'DexScreener'));
  }

  if (holders == null) {
    checks.push(check('HOLDER_COUNT', 'UNKNOWN', 1, '', 'Holder count unavailable; concentration checks remain unresolved.', 'Blockscout'));
  } else if (holders < 5) {
    checks.push(check('HOLDER_COUNT', 'WARN', 2, holders, 'Very low holder count at snapshot time.', 'Blockscout'));
  } else {
    checks.push(check('HOLDER_COUNT', 'PASS', 0, holders, 'Holder count was available at snapshot time.', 'Blockscout'));
  }

  checks.push(check('SELLABILITY', 'UNKNOWN', 1, '', 'No independent sell simulation has been completed yet.', 'pending'));
  checks.push(check('MINT_AUTHORITY', 'UNKNOWN', 1, '', 'Mint/issuance privileges have not been independently decoded yet.', 'pending'));
  checks.push(check('BLACKLIST_LOGIC', 'UNKNOWN', 1, '', 'Blacklist/transfer restriction logic has not been independently decoded yet.', 'pending'));
  checks.push(check('OWNER_PRIVILEGES', 'UNKNOWN', 1, '', 'Owner/admin/proxy privileges have not been independently decoded yet.', 'pending'));

  if (/403|429|ERR/i.test(text(sourceStatus))) {
    checks.push(check('DATA_SOURCE_HEALTH', 'WARN', 1, sourceStatus, 'At least one enrichment source was degraded for this snapshot.', 'worker'));
  } else {
    checks.push(check('DATA_SOURCE_HEALTH', 'PASS', 0, sourceStatus, 'No hard source error recorded for this snapshot.', 'worker'));
  }

  return { token, checks };
}

export function saveRiskChecks(context = {}) {
  ensureRiskSchema();
  const db = getDatabase();
  const snapshot = context.snapshot || {};
  const token = lower(snapshot.token_address);
  if (!/^0x[a-f0-9]{40}$/.test(token)) return { saved: 0, token, counts: {} };
  const poolKey = lower(snapshot.pool_key);
  const snapshotType = text(snapshot.snapshot_type);
  const checkedAt = new Date().toISOString();
  const { checks } = buildRiskChecks(context);
  const stmt = db.prepare(`
    INSERT INTO risk_checks (
      risk_key, token_address, pool_key, snapshot_type, check_name,
      status, severity, value, details, source, checked_at, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(risk_key) DO UPDATE SET
      status=excluded.status,
      severity=excluded.severity,
      value=excluded.value,
      details=excluded.details,
      source=excluded.source,
      checked_at=excluded.checked_at,
      raw_data=excluded.raw_data
  `);
  const tx = db.transaction(() => {
    let saved = 0;
    for (const c of checks) {
      const key = `${token}:${poolKey}:${snapshotType}:${c.name}`;
      const raw = safeJson({ snapshotAt: snapshot.snapshot_at, sourceStatus: context.sourceStatus, check: c });
      const r = stmt.run(key, token, poolKey, snapshotType, c.name, c.status, c.severity, c.value, c.details, c.source, checkedAt, raw);
      saved += r.changes;
    }
    return saved;
  });
  const saved = tx();
  const counts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) AS n FROM risk_checks
    WHERE token_address=? AND pool_key=? AND snapshot_type=? GROUP BY status
  `).all(token, poolKey, snapshotType).map(r => [r.status, Number(r.n)]));
  return { saved, token, poolKey, snapshotType, counts };
}

export function getRiskHealth() {
  ensureRiskSchema();
  const db = getDatabase();
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM risk_checks').get()?.n || 0);
  const fail = Number(db.prepare("SELECT COUNT(*) AS n FROM risk_checks WHERE status='FAIL'").get()?.n || 0);
  const warn = Number(db.prepare("SELECT COUNT(*) AS n FROM risk_checks WHERE status='WARN'").get()?.n || 0);
  const unknown = Number(db.prepare("SELECT COUNT(*) AS n FROM risk_checks WHERE status='UNKNOWN'").get()?.n || 0);
  return { riskChecks: total, riskFail: fail, riskWarn: warn, riskUnknown: unknown };
}
