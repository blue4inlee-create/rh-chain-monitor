import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  formatUnits,
} from 'viem';
import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const VERSION = 'fast-m30-shadow-v1.0';
const SCORE_VERSION = 'score-v2.0-fast-counterfactual';
const CFG = {
  chainId: 4663,
  rpc: process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chain: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',
  ponsFactory: process.env.PONS_V2_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  weth: (process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase(),
  pollMs: Math.max(1000, Number(process.env.FAST_M30_POLL_MS || 2000)),
  baselineMinSec: Math.max(1, Number(process.env.FAST_M30_BASELINE_MIN_SEC || 5)),
  baselineMaxSec: Math.max(8, Number(process.env.FAST_M30_BASELINE_MAX_SEC || 18)),
  m30MinSec: Math.max(18, Number(process.env.FAST_M30_MIN_SEC || 22)),
  m30MaxSec: Math.max(30, Number(process.env.FAST_M30_MAX_SEC || 40)),
  qualifyMaxSec: Math.max(30, Number(process.env.FAST_M30_QUALIFY_MAX_SEC || 35)),
  batchSize: Math.max(1, Math.min(8, Number(process.env.FAST_M30_BATCH || 4))),
  rpcGapMs: Math.max(25, Number(process.env.FAST_M30_RPC_GAP_MS || 80)),
};

const client = createPublicClient({
  chain: {
    id: CFG.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CFG.rpc] } },
  },
  transport: http(CFG.rpc, { timeout: 10_000, retryCount: 0 }),
});

const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);
const factoryAbi = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
]);
const curveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
]);

const quoteDecimalsCache = new Map();
const quotePriceCache = new Map();
let rpcTail = Promise.resolve();
let rpcLastAt = 0;
let stopping = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function validAddress(v) { return /^0x[a-fA-F0-9]{40}$/.test(text(v)); }
function nativeQuote(v) { return !v || text(v).toLowerCase() === ZERO; }
function pctChange(current, initial) {
  const a = num(current), b = num(initial);
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}
function clamp(v, lo=0, hi=100) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }
function safeJson(v) { try { return JSON.stringify(v); } catch { return '{}'; } }

function scheduleRpc(fn) {
  const run = async () => {
    const wait = CFG.rpcGapMs - (Date.now() - rpcLastAt);
    if (wait > 0) await sleep(wait);
    try { return await fn(); }
    finally { rpcLastAt = Date.now(); }
  };
  const p = rpcTail.then(run, run);
  rpcTail = p.catch(() => {});
  return p;
}

async function readContract(address, abi, functionName, args = []) {
  if (!validAddress(address)) return null;
  try {
    return await scheduleRpc(() => client.readContract({
      address: getAddress(address), abi, functionName, args,
    }));
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs=4500) {
  try {
    const res = await fetch(url, {
      headers: { accept:'application/json', 'user-agent':`rh-${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function quoteDecimals(quote) {
  if (nativeQuote(quote) || text(quote).toLowerCase() === CFG.weth) return 18;
  const key = text(quote).toLowerCase();
  if (quoteDecimalsCache.has(key)) return quoteDecimalsCache.get(key);
  const d = await readContract(key, erc20Abi, 'decimals');
  const n = d == null ? null : Number(d);
  if (n != null) quoteDecimalsCache.set(key, n);
  return n;
}

async function quoteUsd(quote) {
  const key = nativeQuote(quote) || text(quote).toLowerCase() === CFG.weth ? 'eth' : text(quote).toLowerCase();
  const cached = quotePriceCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  let price = null;
  if (key === 'eth') {
    const data = await fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    price = num(data?.data?.amount);
  } else if (validAddress(key)) {
    const data = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${key}`);
    if (Array.isArray(data)) {
      const best = [...data].sort((a,b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
      price = num(best?.priceUsd);
    }
  }
  if (price != null && price > 0) quotePriceCache.set(key, { price, at:Date.now() });
  return price;
}

function ensureSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS fast_m30_shadow (
      token_address TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      baseline_at TEXT,
      baseline_age_sec REAL,
      m30_at TEXT,
      m30_age_sec REAL,
      curve TEXT NOT NULL DEFAULT '',
      pair_token TEXT NOT NULL DEFAULT '',
      token_decimals INTEGER,
      total_supply TEXT NOT NULL DEFAULT '',
      graduation_threshold TEXT NOT NULL DEFAULT '',
      baseline_price_quote REAL,
      baseline_price_usd REAL,
      baseline_market_cap REAL,
      baseline_reserve_usd REAL,
      baseline_progress_pct REAL,
      m30_price_quote REAL,
      m30_price_usd REAL,
      m30_market_cap REAL,
      m30_reserve_usd REAL,
      m30_progress_pct REAL,
      price_change_pct REAL,
      market_cap_change_pct REAL,
      reserve_change_pct REAL,
      progress_delta REAL,
      score_v2 REAL,
      qualifies_canary1 INTEGER NOT NULL DEFAULT 0,
      hard_fail INTEGER NOT NULL DEFAULT 0,
      shadow_entry_at TEXT,
      shadow_entry_price_usd REAL,
      shadow_entry_market_cap REAL,
      score_reason_json TEXT NOT NULL DEFAULT '{}',
      score_version TEXT NOT NULL DEFAULT '',
      scored_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_fast_m30_at ON fast_m30_shadow(m30_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fast_m30_qualify ON fast_m30_shadow(qualifies_canary1, m30_at DESC);
  `);
}

function ageSec(firstSeen) {
  const ms = Date.now() - new Date(firstSeen).getTime();
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function dueBaselines() {
  const db = getDatabase();
  const now = Date.now();
  const newest = new Date(now - CFG.baselineMinSec * 1000).toISOString();
  const oldest = new Date(now - CFG.baselineMaxSec * 1000).toISOString();
  return db.prepare(`
    SELECT t.token_address, t.first_seen_at, t.decimals, t.total_supply
    FROM tokens t
    WHERE t.first_source LIKE 'Pons%'
      AND t.first_seen_at >= ? AND t.first_seen_at <= ?
      AND NOT EXISTS (SELECT 1 FROM fast_m30_shadow f WHERE f.token_address=t.token_address)
    ORDER BY t.first_seen_at ASC
    LIMIT ?
  `).all(oldest, newest, CFG.batchSize);
}

function dueM30() {
  const db = getDatabase();
  const now = Date.now();
  const newest = new Date(now - CFG.m30MinSec * 1000).toISOString();
  const oldest = new Date(now - CFG.m30MaxSec * 1000).toISOString();
  return db.prepare(`
    SELECT f.* FROM fast_m30_shadow f
    WHERE f.baseline_at IS NOT NULL AND f.m30_at IS NULL
      AND f.first_seen_at >= ? AND f.first_seen_at <= ?
    ORDER BY f.first_seen_at ASC
    LIMIT ?
  `).all(oldest, newest, CFG.batchSize);
}

async function launchInfo(token, tokenRow={}) {
  const launch = await readContract(CFG.ponsFactory, factoryAbi, 'getLaunchedToken', [getAddress(token)]);
  if (!launch?.exists || !validAddress(launch.curve)) return null;
  let decimals = Number.isFinite(Number(tokenRow.decimals)) ? Number(tokenRow.decimals) : null;
  let totalSupply = text(tokenRow.total_supply);
  if (decimals == null || !totalSupply) {
    const [d, supply] = await Promise.all([
      decimals == null ? readContract(token, erc20Abi, 'decimals') : Promise.resolve(decimals),
      !totalSupply ? readContract(token, erc20Abi, 'totalSupply') : Promise.resolve(totalSupply),
    ]);
    if (decimals == null && d != null) decimals = Number(d);
    if (!totalSupply && supply != null) totalSupply = supply.toString();
  }
  return {
    curve: text(launch.curve).toLowerCase(),
    pairToken: text(launch.pairToken).toLowerCase(),
    graduationThreshold: launch.graduationThreshold == null ? '' : launch.graduationThreshold.toString(),
    decimals,
    totalSupply,
  };
}

async function curveMetrics(meta) {
  const [reserves, realQuote, qDecimals, qUsd] = await Promise.all([
    readContract(meta.curve, curveAbi, 'getReserves'),
    readContract(meta.curve, curveAbi, 'realQuoteReserve'),
    quoteDecimals(meta.pairToken),
    quoteUsd(meta.pairToken),
  ]);
  if (!reserves || qDecimals == null || meta.decimals == null) return null;
  const quoteReserve = Number(formatUnits(BigInt(reserves[0]), qDecimals));
  const tokenReserve = Number(formatUnits(BigInt(reserves[1]), meta.decimals));
  if (!(quoteReserve >= 0) || !(tokenReserve > 0)) return null;
  const priceQuote = quoteReserve / tokenReserve;
  const priceUsd = qUsd != null ? priceQuote * qUsd : null;
  let marketCap = null;
  if (priceUsd != null && meta.totalSupply) {
    const supply = Number(formatUnits(BigInt(meta.totalSupply), meta.decimals));
    if (Number.isFinite(supply)) marketCap = priceUsd * supply;
  }
  let reserveUsd = null;
  if (realQuote != null && qUsd != null) {
    const real = Number(formatUnits(BigInt(realQuote), qDecimals));
    if (Number.isFinite(real)) reserveUsd = real * qUsd;
  }
  let progress = null;
  if (realQuote != null && meta.graduationThreshold && BigInt(meta.graduationThreshold) > 0n) {
    progress = Number(BigInt(realQuote) * 1_000_000n / BigInt(meta.graduationThreshold)) / 10_000;
  }
  return { priceQuote, priceUsd, marketCap, reserveUsd, progress };
}

async function captureBaseline(row) {
  const token = text(row.token_address).toLowerCase();
  const meta = await launchInfo(token, row);
  if (!meta) return false;
  const metrics = await curveMetrics(meta);
  if (!metrics) return false;
  const now = new Date().toISOString();
  const age = ageSec(row.first_seen_at);
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO fast_m30_shadow (
      token_address, first_seen_at, baseline_at, baseline_age_sec,
      curve, pair_token, token_decimals, total_supply, graduation_threshold,
      baseline_price_quote, baseline_price_usd, baseline_market_cap,
      baseline_reserve_usd, baseline_progress_pct, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    token, row.first_seen_at, now, age,
    meta.curve, meta.pairToken, meta.decimals, meta.totalSupply, meta.graduationThreshold,
    metrics.priceQuote, metrics.priceUsd, metrics.marketCap,
    metrics.reserveUsd, metrics.progress, now, now,
  );
  console.log('[fast-m30 baseline]', JSON.stringify({ token, ageSec:age, mcap:metrics.marketCap, reserve:metrics.reserveUsd }));
  return true;
}

async function captureM30(row) {
  const meta = {
    curve: row.curve,
    pairToken: row.pair_token,
    decimals: num(row.token_decimals),
    totalSupply: row.total_supply,
    graduationThreshold: row.graduation_threshold,
  };
  const metrics = await curveMetrics(meta);
  if (!metrics) return false;
  const now = new Date().toISOString();
  const age = ageSec(row.first_seen_at);
  const db = getDatabase();
  db.prepare(`
    UPDATE fast_m30_shadow SET
      m30_at=?, m30_age_sec=?, m30_price_quote=?, m30_price_usd=?, m30_market_cap=?,
      m30_reserve_usd=?, m30_progress_pct=?,
      price_change_pct=?, market_cap_change_pct=?, reserve_change_pct=?, progress_delta=?, updated_at=?
    WHERE token_address=? AND m30_at IS NULL
  `).run(
    now, age, metrics.priceQuote, metrics.priceUsd, metrics.marketCap,
    metrics.reserveUsd, metrics.progress,
    pctChange(metrics.priceQuote, row.baseline_price_quote),
    pctChange(metrics.marketCap, row.baseline_market_cap),
    pctChange(metrics.reserveUsd, row.baseline_reserve_usd),
    metrics.progress != null && num(row.baseline_progress_pct) != null ? metrics.progress - Number(row.baseline_progress_pct) : null,
    now, row.token_address,
  );
  console.log('[fast-m30 capture]', JSON.stringify({ token:row.token_address, ageSec:age, mcap:metrics.marketCap, reserve:metrics.reserveUsd }));
  return true;
}

function reserveLevelScore(reserve) {
  const r = num(reserve); if (r == null) return 0;
  if (r < 100) return 2; if (r < 300) return 5; if (r < 500) return 8;
  if (r < 1000) return 12; if (r < 1800) return 16; if (r < 3000) return 18;
  if (r <= 5000) return 16; return 10;
}
function reserveVelocityScore(changePct) {
  const c = num(changePct); if (c == null) return 0;
  if (c <= -10) return 0; if (c < 0) return 3; if (c < 5) return 6;
  if (c < 15) return 12; if (c < 30) return 18; if (c < 60) return 22; return 25;
}
function progressVelocityScore(delta) {
  const d = num(delta); if (d == null) return 0;
  if (d < 0) return 0; if (d < 0.25) return 4; if (d < 1) return 8;
  if (d < 3) return 13; if (d < 6) return 17; return 20;
}
function priceQualityScore(changePct) {
  const c = num(changePct); if (c == null) return 0;
  if (c < -10) return 0; if (c < -3) return 3; if (c < 1) return 7;
  if (c < 5) return 10; if (c < 15) return 13; if (c < 35) return 15;
  if (c < 60) return 10; return 5;
}
function marketCapPenalty(mc) {
  const m = num(mc); if (m == null) return 0;
  if (m >= 20000) return 18; if (m >= 15000) return 12;
  if (m >= 12000) return 8; if (m >= 10000) return 5; return 0;
}

function rescoreReady() {
  const db = getDatabase();
  const hasScores = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scores'").get();
  if (!hasScores) return 0;
  const hasRisk = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='risk_checks'").get();
  const rows = db.prepare(`
    SELECT f.*, s.discovery_score, s.risk_score
    FROM fast_m30_shadow f
    JOIN scores s ON s.id=(
      SELECT s2.id FROM scores s2
      WHERE s2.token_address=f.token_address AND s2.snapshot_type='INITIAL' AND s2.score_version='score-v1.0'
      ORDER BY s2.scored_at DESC, s2.id DESC LIMIT 1
    )
    WHERE f.m30_at IS NOT NULL AND f.score_v2 IS NULL
    ORDER BY f.m30_at ASC LIMIT 100
  `).all();
  const update = db.prepare(`
    UPDATE fast_m30_shadow SET score_v2=?, qualifies_canary1=?, hard_fail=?,
      shadow_entry_at=?, shadow_entry_price_usd=?, shadow_entry_market_cap=?,
      score_reason_json=?, score_version=?, scored_at=?, updated_at=?
    WHERE token_address=?
  `);
  let n = 0;
  for (const row of rows) {
    const structural = clamp((num(row.discovery_score)||0)*0.65 + (num(row.risk_score)||0)*0.45, 0, 20);
    const reserveLevel = reserveLevelScore(row.m30_reserve_usd);
    const reserveVelocity = reserveVelocityScore(row.reserve_change_pct);
    const progressVelocity = progressVelocityScore(row.progress_delta);
    const priceQuality = priceQualityScore(row.price_change_pct);
    let penalty = marketCapPenalty(row.m30_market_cap);
    const exhaustion = (num(row.baseline_reserve_usd) != null && Number(row.baseline_reserve_usd) >= 500 && num(row.reserve_change_pct) != null && Number(row.reserve_change_pct) <= 0)
      || (num(row.baseline_progress_pct) != null && Number(row.baseline_progress_pct) >= 5 && num(row.progress_delta) != null && Number(row.progress_delta) <= 0 && (num(row.price_change_pct) ?? 0) <= 1);
    if (exhaustion) penalty += 12;
    let alphaBonus = 0;
    const sustained = num(row.reserve_change_pct) != null && Number(row.reserve_change_pct) >= 20
      && num(row.progress_delta) != null && Number(row.progress_delta) >= 1
      && num(row.price_change_pct) != null && Number(row.price_change_pct) >= 2 && Number(row.price_change_pct) <= 35;
    if (sustained) alphaBonus += 8;
    const score = clamp(structural + reserveLevel + reserveVelocity + progressVelocity + priceQuality + alphaBonus - penalty, 0, 100);
    const hardFail = hasRisk ? Number(db.prepare(`SELECT EXISTS(SELECT 1 FROM risk_checks WHERE token_address=? AND status='FAIL') AS x`).get(row.token_address)?.x || 0) : 0;
    const qualifies = Number(row.m30_age_sec) >= 20 && Number(row.m30_age_sec) <= CFG.qualifyMaxSec && score >= 60 && !hardFail;
    const now = new Date().toISOString();
    const reason = { structural, reserveLevel, reserveVelocity, progressVelocity, priceQuality, alphaBonus, penalty, exhaustion, sustained, m30AgeSec:row.m30_age_sec, qualifyMaxSec:CFG.qualifyMaxSec };
    update.run(
      score, qualifies ? 1 : 0, hardFail,
      qualifies ? row.m30_at : null,
      qualifies ? row.m30_price_usd : null,
      qualifies ? row.m30_market_cap : null,
      safeJson(reason), SCORE_VERSION, now, now, row.token_address,
    );
    n++;
  }
  if (n) console.log('[fast-m30 rescore]', JSON.stringify({ rescored:n }));
  return n;
}

function health() {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN baseline_at IS NOT NULL THEN 1 ELSE 0 END) AS baselines,
      SUM(CASE WHEN m30_at IS NOT NULL THEN 1 ELSE 0 END) AS m30,
      SUM(CASE WHEN m30_age_sec BETWEEN 20 AND ? THEN 1 ELSE 0 END) AS true_m30,
      SUM(CASE WHEN qualifies_canary1=1 THEN 1 ELSE 0 END) AS qualifies,
      MAX(m30_at) AS latest_m30
    FROM fast_m30_shadow
  `).get(CFG.qualifyMaxSec) || {};
  return {
    total:Number(row.total||0), baselines:Number(row.baselines||0), m30:Number(row.m30||0),
    trueM30:Number(row.true_m30||0), qualifies:Number(row.qualifies||0), latestM30:row.latest_m30||null,
  };
}

async function main() {
  const dbStatus = initializeDatabase();
  ensureSchema();
  console.log('[fast-m30 boot]', JSON.stringify({ version:VERSION, scoreVersion:SCORE_VERSION, db:dbStatus, cfg:CFG, health:health() }));
  let lastHealth = 0;
  while (!stopping) {
    try {
      for (const row of dueBaselines()) {
        if (stopping) break;
        await captureBaseline(row);
      }
      for (const row of dueM30()) {
        if (stopping) break;
        await captureM30(row);
      }
      rescoreReady();
      if (Date.now() - lastHealth > 60_000) {
        console.log('[fast-m30 health]', JSON.stringify(health()));
        lastHealth = Date.now();
      }
    } catch (err) {
      console.error('[fast-m30 error]', text(err?.message || err));
    }
    await sleep(CFG.pollMs);
  }
}

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`[fast-m30] ${sig}`);
  setTimeout(() => { try { closeDatabase(); } catch {} }, 50).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
  console.error('[fast-m30 fatal]', err);
  process.exitCode = 1;
});
