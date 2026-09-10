import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  formatUnits,
} from 'viem';
import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';
import { ensurePriceMilestoneSchema } from './price_milestones.mjs';
import { ensureAthSchema, recordMarketTick, getAthHealth } from './ath_metrics.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const VERSION = '2.16.1-marlin30';
const CFG = {
  chainId: 4663,
  rpc: process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chain: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',
  ponsFactory: process.env.PONS_V2_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  weth: (process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase(),
  cycleMs: Math.max(15_000, Number(process.env.CANARY_TRACK_CYCLE_MS || 30_000)),
  minIntervalMs: Math.max(60_000, Number(process.env.CANARY_TRACK_INTERVAL_MS || 300_000)),
  batchSize: Math.max(1, Math.min(20, Number(process.env.CANARY_TRACK_BATCH || 4))),
  rpcGapMs: Math.max(150, Number(process.env.CANARY_TRACK_RPC_GAP_MS || 300)),
  shadowEnabled: !/^(0|false|no)$/i.test(String(process.env.SHADOW_TRACK_ENABLED || 'true')),
  shadowMinScore: Math.max(0, Number(process.env.SHADOW_TRACK_MIN_SCORE || 45)),
  shadowMinAgeMs: Math.max(60_000, Number(process.env.SHADOW_TRACK_MIN_AGE_MS || 120_000)),
  shadowMaxAgeMs: Math.max(5 * 60_000, Number(process.env.SHADOW_TRACK_MAX_AGE_MS || 30 * 60_000)),
  shadowIntervalMs: Math.max(60_000, Number(process.env.SHADOW_TRACK_INTERVAL_MS || 300_000)),
  shadowBatchSize: Math.max(1, Math.min(10, Number(process.env.SHADOW_TRACK_BATCH || 2))),
  marlinEnabled: !/^(0|false|no)$/i.test(String(process.env.MARLIN_30S_ENABLED || 'true')),
  marlinMinScore: Math.max(0, Number(process.env.MARLIN_30S_MIN_SCORE || 48)),
  marlinMinAgeMs: Math.max(15_000, Number(process.env.MARLIN_30S_MIN_AGE_MS || 22_000)),
  marlinMaxAgeMs: Math.max(45_000, Number(process.env.MARLIN_30S_MAX_AGE_MS || 90_000)),
  marlinPollMs: Math.max(3_000, Number(process.env.MARLIN_30S_POLL_MS || 5_000)),
  marlinBatchSize: Math.max(1, Math.min(4, Number(process.env.MARLIN_30S_BATCH || 1))),
};

const client = createPublicClient({
  chain: {
    id: CFG.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CFG.rpc] } },
  },
  transport: http(CFG.rpc, { timeout: 15_000, retryCount: 0 }),
});

const erc20Abi = parseAbi(['function decimals() view returns (uint8)']);
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
function rateLimited(err) { return /429|rate.?limit|too many requests|-32005/i.test(text(err?.message || err)); }
function pctChange(current, initial) {
  const a = num(current), b = num(initial);
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}
function safeJson(v) {
  try { return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x); }
  catch { return '{}'; }
}
function parseJson(v) {
  try { return JSON.parse(String(v || '{}')); }
  catch { return {}; }
}

function scheduleRpc(fn) {
  const run = async () => {
    const gap = CFG.rpcGapMs - (Date.now() - rpcLastAt);
    if (gap > 0) await sleep(gap);
    try { return await fn(); }
    finally { rpcLastAt = Date.now(); }
  };
  const p = rpcTail.then(run, run);
  rpcTail = p.catch(() => {});
  return p;
}

async function readContract(address, abi, functionName, args = []) {
  if (!validAddress(address)) return null;
  for (const delay of [0, 1500, 5000]) {
    if (delay) await sleep(delay);
    try {
      return await scheduleRpc(() => client.readContract({ address: getAddress(address), abi, functionName, args }));
    } catch (err) {
      if (!rateLimited(err)) return null;
    }
  }
  return null;
}

async function fetchJson(url, timeoutMs = 7000) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': `rh-canary-market-tracker/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: text(err?.message || err), data: null };
  }
}

async function dexPairs(token) {
  const r = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${token}`);
  return r.ok && Array.isArray(r.data) ? r.data : [];
}
function bestPair(pairs, preferredPool = '') {
  const list = Array.isArray(pairs) ? pairs : [];
  const preferred = text(preferredPool).toLowerCase();
  if (preferred) {
    const exact = list.find(p => text(p?.pairAddress).toLowerCase() === preferred);
    if (exact) return exact;
  }
  return [...list].sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;
}

async function quoteDecimals(quote) {
  if (nativeQuote(quote)) return 18;
  const key = text(quote).toLowerCase();
  if (quoteDecimalsCache.has(key)) return quoteDecimalsCache.get(key);
  const d = await readContract(quote, erc20Abi, 'decimals');
  const n = d == null ? null : Number(d);
  if (n != null) quoteDecimalsCache.set(key, n);
  return n;
}

async function quoteUsd(quote) {
  const key = nativeQuote(quote) ? 'eth' : text(quote).toLowerCase();
  const cached = quotePriceCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  let price = null;
  if (nativeQuote(quote) || key === CFG.weth) {
    const r = await fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot', 5000);
    price = num(r.data?.data?.amount);
  }
  if (price == null && validAddress(quote)) {
    const pair = bestPair(await dexPairs(quote));
    price = num(pair?.priceUsd);
  }
  if (price != null && price > 0) quotePriceCache.set(key, { price, at: Date.now() });
  return price;
}

async function ponsMetrics(row) {
  const token = row.token_address;
  const launch = await readContract(CFG.ponsFactory, factoryAbi, 'getLaunchedToken', [getAddress(token)]);
  if (!launch?.exists || Number(launch.phase ?? 0) !== 0 || !validAddress(launch.curve)) return null;
  const [reserves, realQuote, qDecimals, qUsd] = await Promise.all([
    readContract(launch.curve, curveAbi, 'getReserves'),
    readContract(launch.curve, curveAbi, 'realQuoteReserve'),
    quoteDecimals(launch.pairToken),
    quoteUsd(launch.pairToken),
  ]);
  if (!reserves || qDecimals == null || qUsd == null) return null;
  const tokenDecimals = Number.isFinite(Number(row.decimals)) ? Number(row.decimals) : 18;
  const quoteReserve = Number(formatUnits(BigInt(reserves[0]), qDecimals));
  const tokenReserve = Number(formatUnits(BigInt(reserves[1]), tokenDecimals));
  if (!(tokenReserve > 0) || !(quoteReserve >= 0)) return null;
  const priceUsd = (quoteReserve / tokenReserve) * qUsd;
  let marketCap = null;
  if (row.total_supply) {
    const supply = Number(formatUnits(BigInt(row.total_supply), tokenDecimals));
    if (Number.isFinite(supply)) marketCap = priceUsd * supply;
  }
  let reserveUsd = null;
  let curveProgressPct = null;
  if (realQuote != null) {
    const realQuoteValue = Number(formatUnits(BigInt(realQuote), qDecimals));
    if (Number.isFinite(realQuoteValue)) reserveUsd = realQuoteValue * qUsd;
    if (launch.graduationThreshold != null && BigInt(launch.graduationThreshold) > 0n) {
      curveProgressPct = Number(BigInt(realQuote) * 1_000_000n / BigInt(launch.graduationThreshold)) / 10_000;
    }
  }
  return {
    priceUsd,
    marketCap,
    liquidityUsd: null,
    buyCount5m: null,
    sellCount5m: null,
    volume5m: null,
    source: 'pons-curve',
    poolKey: text(launch.curve).toLowerCase(),
    reserveUsd,
    curveProgressPct,
    phase: Number(launch.phase ?? 0),
    raw: {
      phase: Number(launch.phase ?? 0),
      pairToken: text(launch.pairToken),
      reserveUsd,
      curveProgressPct,
    },
  };
}

async function marketMetrics(row) {
  const pairs = await dexPairs(row.token_address);
  const pair = bestPair(pairs, row.first_pool_key);
  const price = num(pair?.priceUsd);
  if (price != null && price > 0) {
    const txns = pair?.txns?.m5 || {};
    return {
      priceUsd: price,
      marketCap: num(pair?.marketCap) ?? num(pair?.fdv),
      liquidityUsd: num(pair?.liquidity?.usd),
      buyCount5m: num(txns?.buys),
      sellCount5m: num(txns?.sells),
      volume5m: num(pair?.volume?.m5),
      source: text(pair?.dexId) || 'dexscreener',
      poolKey: text(pair?.pairAddress).toLowerCase() || row.first_pool_key,
      reserveUsd: null,
      curveProgressPct: null,
      phase: null,
      raw: { pairAddress: pair?.pairAddress || '', dexId: pair?.dexId || '' },
    };
  }
  return ponsMetrics(row);
}

function ensureMarlinSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marlin_30s (
      token_address TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      age_sec REAL,
      stage_at_observation TEXT NOT NULL DEFAULT '',
      initial_at TEXT,
      initial_price_usd REAL,
      price_usd REAL,
      price_change_pct REAL,
      initial_market_cap REAL,
      market_cap REAL,
      market_cap_change_pct REAL,
      initial_reserve_usd REAL,
      reserve_usd REAL,
      reserve_change_pct REAL,
      initial_curve_progress_pct REAL,
      curve_progress_pct REAL,
      curve_progress_delta REAL,
      score_at_observation REAL,
      graduated INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      raw_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_marlin30_observed ON marlin_30s(observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_marlin30_score ON marlin_30s(score_at_observation DESC);
  `);
}

function dueCanaries() {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - CFG.minIntervalMs).toISOString();
  return db.prepare(`
    SELECT t.token_address, t.decimals, t.total_supply, t.first_pool_key, t.canary_at,
           MAX(m.tick_at) AS last_tick_at
    FROM tokens t
    LEFT JOIN market_ticks m
      ON m.token_address=t.token_address AND m.tick_at >= t.canary_at
    WHERE t.monitor_stage IN ('CANARY','EARLY_ALPHA','CONFIRMED_ALPHA','SIZE_UP')
    GROUP BY t.token_address
    HAVING last_tick_at IS NULL OR last_tick_at <= ?
    ORDER BY
      CASE WHEN last_tick_at IS NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN last_tick_at IS NULL THEN t.canary_at END DESC,
      last_tick_at ASC
    LIMIT ?
  `).all(cutoff, CFG.batchSize);
}

function dueShadows() {
  if (!CFG.shadowEnabled) return [];
  const db = getDatabase();
  const now = Date.now();
  const oldest = new Date(now - CFG.shadowMaxAgeMs).toISOString();
  const newest = new Date(now - CFG.shadowMinAgeMs).toISOString();
  const cutoff = new Date(now - CFG.shadowIntervalMs).toISOString();
  return db.prepare(`
    SELECT t.token_address, t.decimals, t.total_supply, t.first_pool_key, t.first_seen_at,
           (
             SELECT s.final_score
             FROM scores s
             WHERE s.token_address=t.token_address
             ORDER BY s.scored_at DESC, s.id DESC
             LIMIT 1
           ) AS latest_score,
           MAX(m.tick_at) AS last_tick_at
    FROM tokens t
    LEFT JOIN market_ticks m ON m.token_address=t.token_address
    WHERE t.monitor_stage='DISCOVERY'
      AND t.first_seen_at >= ?
      AND t.first_seen_at <= ?
      AND COALESCE((
        SELECT s.final_score
        FROM scores s
        WHERE s.token_address=t.token_address
        ORDER BY s.scored_at DESC, s.id DESC
        LIMIT 1
      ), 0) >= ?
    GROUP BY t.token_address
    HAVING last_tick_at IS NULL OR last_tick_at <= ?
    ORDER BY
      CASE WHEN last_tick_at IS NULL THEN 0 ELSE 1 END ASC,
      latest_score DESC,
      CASE WHEN last_tick_at IS NULL THEN t.first_seen_at END DESC,
      last_tick_at ASC
    LIMIT ?
  `).all(oldest, newest, CFG.shadowMinScore, cutoff, CFG.shadowBatchSize);
}

function dueMarlinWindows() {
  if (!CFG.marlinEnabled) return [];
  ensureMarlinSchema();
  const db = getDatabase();
  const now = Date.now();
  const oldest = new Date(now - CFG.marlinMaxAgeMs).toISOString();
  const newest = new Date(now - CFG.marlinMinAgeMs).toISOString();
  return db.prepare(`
    SELECT t.token_address, t.decimals, t.total_supply, t.first_pool_key,
           t.first_seen_at, t.monitor_stage,
           (
             SELECT s.final_score FROM scores s
             WHERE s.token_address=t.token_address
             ORDER BY s.scored_at DESC, s.id DESC LIMIT 1
           ) AS latest_score
    FROM tokens t
    WHERE t.first_source LIKE 'Pons%'
      AND t.first_seen_at >= ?
      AND t.first_seen_at <= ?
      AND EXISTS (
        SELECT 1 FROM snapshots x
        WHERE x.token_address=t.token_address AND x.snapshot_type='INITIAL'
      )
      AND COALESCE((
        SELECT s.final_score FROM scores s
        WHERE s.token_address=t.token_address
        ORDER BY s.scored_at DESC, s.id DESC LIMIT 1
      ), 0) >= ?
      AND NOT EXISTS (
        SELECT 1 FROM marlin_30s w WHERE w.token_address=t.token_address
      )
    ORDER BY t.first_seen_at DESC
    LIMIT ?
  `).all(oldest, newest, CFG.marlinMinScore, CFG.marlinBatchSize);
}

async function trackRows(rows, label) {
  for (const row of rows) {
    if (stopping) return;
    const metrics = await marketMetrics(row);
    if (!metrics) {
      console.log(`[${label} tick pending]`, JSON.stringify({ token: row.token_address, score: row.latest_score ?? null }));
      continue;
    }
    const result = recordMarketTick({
      tokenAddress: row.token_address,
      poolKey: metrics.poolKey,
      tickAt: new Date().toISOString(),
      ...metrics,
      raw: { ...metrics.raw, trackingMode: label, scoreAtSelection: row.latest_score ?? null },
    });
    console.log(`[${label} tick]`, JSON.stringify({
      token: row.token_address,
      score: row.latest_score ?? null,
      price: metrics.priceUsd,
      marketCap: metrics.marketCap,
      liquidity: metrics.liquidityUsd,
      source: metrics.source,
      discoveryMultiple: result.discoveryMultiple,
      canaryMultiple: result.canaryMultiple,
      newAth: result.newAthPrice,
    }));
  }
}

function recordMarlinWindow(row, metrics) {
  const db = getDatabase();
  const initial = db.prepare(`
    SELECT snapshot_at, price_usd, market_cap, raw_data
    FROM snapshots
    WHERE token_address=? AND snapshot_type='INITIAL'
    ORDER BY snapshot_at ASC, id ASC LIMIT 1
  `).get(row.token_address) || {};
  const initialRaw = parseJson(initial.raw_data);
  const initialPons = initialRaw?.pons || {};
  const observedAt = new Date().toISOString();
  const ageSec = Math.max(0, (new Date(observedAt).getTime() - new Date(row.first_seen_at).getTime()) / 1000);
  const initialReserve = num(initialPons.reserveUsd);
  const initialProgress = num(initialPons.curveProgressPct);
  const reserve = num(metrics.reserveUsd);
  let progress = num(metrics.curveProgressPct);
  const graduated = metrics.source !== 'pons-curve';
  if (graduated && progress == null) progress = 100;
  const out = {
    token_address: row.token_address,
    first_seen_at: row.first_seen_at,
    observed_at: observedAt,
    age_sec: Math.round(ageSec * 10) / 10,
    stage_at_observation: text(row.monitor_stage),
    initial_at: initial.snapshot_at || null,
    initial_price_usd: num(initial.price_usd),
    price_usd: num(metrics.priceUsd),
    price_change_pct: pctChange(metrics.priceUsd, initial.price_usd),
    initial_market_cap: num(initial.market_cap),
    market_cap: num(metrics.marketCap),
    market_cap_change_pct: pctChange(metrics.marketCap, initial.market_cap),
    initial_reserve_usd: initialReserve,
    reserve_usd: reserve,
    reserve_change_pct: pctChange(reserve, initialReserve),
    initial_curve_progress_pct: initialProgress,
    curve_progress_pct: progress,
    curve_progress_delta: progress != null && initialProgress != null ? progress - initialProgress : null,
    score_at_observation: num(row.latest_score),
    graduated: graduated ? 1 : 0,
    source: text(metrics.source),
    raw_data: safeJson({ metrics, initialPons }),
    created_at: observedAt,
  };
  db.prepare(`
    INSERT OR IGNORE INTO marlin_30s (
      token_address, first_seen_at, observed_at, age_sec, stage_at_observation,
      initial_at, initial_price_usd, price_usd, price_change_pct,
      initial_market_cap, market_cap, market_cap_change_pct,
      initial_reserve_usd, reserve_usd, reserve_change_pct,
      initial_curve_progress_pct, curve_progress_pct, curve_progress_delta,
      score_at_observation, graduated, source, raw_data, created_at
    ) VALUES (
      @token_address, @first_seen_at, @observed_at, @age_sec, @stage_at_observation,
      @initial_at, @initial_price_usd, @price_usd, @price_change_pct,
      @initial_market_cap, @market_cap, @market_cap_change_pct,
      @initial_reserve_usd, @reserve_usd, @reserve_change_pct,
      @initial_curve_progress_pct, @curve_progress_pct, @curve_progress_delta,
      @score_at_observation, @graduated, @source, @raw_data, @created_at
    )
  `).run(out);
  return out;
}

async function captureMarlinWindows() {
  for (const row of dueMarlinWindows()) {
    if (stopping) return;
    const metrics = await marketMetrics(row);
    if (!metrics || num(metrics.priceUsd) == null) {
      console.log('[marlin 30s pending]', JSON.stringify({ token: row.token_address, score: row.latest_score ?? null }));
      continue;
    }
    const out = recordMarlinWindow(row, metrics);
    console.log('[marlin 30s]', JSON.stringify({
      token: out.token_address,
      ageSec: out.age_sec,
      stage: out.stage_at_observation,
      score: out.score_at_observation,
      priceChangePct: out.price_change_pct,
      reserveUsd: out.reserve_usd,
      reserveChangePct: out.reserve_change_pct,
      curveProgressPct: out.curve_progress_pct,
      curveProgressDelta: out.curve_progress_delta,
      marketCap: out.market_cap,
      graduated: Boolean(out.graduated),
      source: out.source,
    }));
  }
}

async function marlinLoop() {
  while (!stopping) {
    try { await captureMarlinWindows(); }
    catch (err) { console.error('[marlin 30s]', text(err?.message || err)); }
    await sleep(CFG.marlinPollMs);
  }
}

async function cycle() {
  await trackRows(dueCanaries(), 'canary');
  if (!stopping) await trackRows(dueShadows(), 'shadow');
}

async function main() {
  initializeDatabase();
  ensurePriceMilestoneSchema();
  ensureAthSchema();
  ensureMarlinSchema();
  console.log('[canary tracker boot]', JSON.stringify({
    version: VERSION,
    priority: 'fresh-marlin30 + new-canary-first + near-miss-shadow',
    cycleMs: CFG.cycleMs,
    minIntervalMs: CFG.minIntervalMs,
    batchSize: CFG.batchSize,
    rpcGapMs: CFG.rpcGapMs,
    shadow: {
      enabled: CFG.shadowEnabled,
      minScore: CFG.shadowMinScore,
      minAgeMs: CFG.shadowMinAgeMs,
      maxAgeMs: CFG.shadowMaxAgeMs,
      intervalMs: CFG.shadowIntervalMs,
      batchSize: CFG.shadowBatchSize,
    },
    marlin30: {
      enabled: CFG.marlinEnabled,
      minScore: CFG.marlinMinScore,
      minAgeMs: CFG.marlinMinAgeMs,
      maxAgeMs: CFG.marlinMaxAgeMs,
      pollMs: CFG.marlinPollMs,
      batchSize: CFG.marlinBatchSize,
      ordering: 'freshest-eligible-first',
    },
    ...getAthHealth(),
  }));
  const marlinTask = marlinLoop();
  while (!stopping) {
    try { await cycle(); }
    catch (err) { console.error('[canary tracker]', text(err?.message || err)); }
    await sleep(CFG.cycleMs);
  }
  await marlinTask;
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

main().catch(err => {
  console.error('[canary tracker fatal]', err);
  process.exitCode = 1;
}).finally(() => {
  try { closeDatabase(); } catch {}
});