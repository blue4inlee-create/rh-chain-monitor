import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  formatUnits,
} from 'viem';
import {
  initializeDatabase,
  claimDueJob,
  completeJob,
  failJob,
  saveSnapshot,
  updateTokenEnrichment,
  getDatabaseHealth,
} from './db.mjs';
import { saveRiskChecks } from './risk.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const CFG = {
  chainId: 4663,
  rpc: process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chain: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',
  ponsFactory: process.env.PONS_V2_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  weth: (process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase(),
  blockscoutKey: String(process.env.BLOCKSCOUT_API_KEY || '').trim(),
  blockscoutProBase: (process.env.BLOCKSCOUT_PRO_BASE || 'https://api.blockscout.com/4663/api/v2').replace(/\/$/, ''),
  pollMs: Math.max(500, Number(process.env.JOB_POLL_MS || 1000)),
};

const client = createPublicClient({
  chain: {
    id: CFG.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CFG.rpc] } },
  },
  transport: http(CFG.rpc, { timeout: 15000, retryCount: 1 }),
});

const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
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
  'function graduationThreshold() view returns (uint256)',
]);

const quotePriceCache = new Map();
const quoteDecimalsCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function text(v) {
  return v == null ? '' : String(v).trim();
}
function numeric(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function validAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(text(v));
}
function nativeQuote(v) {
  return !v || text(v).toLowerCase() === ZERO;
}

async function fetchJson(url, timeoutMs = 7000, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'rh-chain-monitor-job-worker/2.6',
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: text(err?.message || err), data: null };
  }
}

async function readContract(address, abi, functionName, args = []) {
  if (!validAddress(address)) return null;
  try {
    return await client.readContract({ address: getAddress(address), abi, functionName, args });
  } catch {
    return null;
  }
}

async function onchainTokenMeta(token) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    readContract(token, erc20Abi, 'name'),
    readContract(token, erc20Abi, 'symbol'),
    readContract(token, erc20Abi, 'decimals'),
    readContract(token, erc20Abi, 'totalSupply'),
  ]);
  return {
    name: text(name),
    symbol: text(symbol),
    decimals: decimals == null ? null : Number(decimals),
    totalSupply: totalSupply == null ? '' : totalSupply.toString(),
  };
}

async function blockscoutToken(token) {
  if (!CFG.blockscoutKey) return {
    meta: { ok: false, status: 'NO_KEY', data: null },
    holders: { ok: false, status: 'NO_KEY', data: null },
  };
  const key = encodeURIComponent(CFG.blockscoutKey);
  const base = `${CFG.blockscoutProBase}/tokens/${token}`;
  const [meta, holders] = await Promise.all([
    fetchJson(`${base}?apikey=${key}`, 6000),
    fetchJson(`${base}/counters?apikey=${key}`, 6000),
  ]);
  return { meta, holders };
}

async function dexPairs(token) {
  const r = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${token}`, 7000);
  return r.ok && Array.isArray(r.data) ? { ok: true, status: r.status, pairs: r.data } : { ok: false, status: r.status, pairs: [] };
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

function holderCount(counters) {
  return numeric(counters?.token_holders_count ?? counters?.holders_count ?? counters?.holder_count);
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
    const n = numeric(r.data?.data?.amount);
    if (n != null && n > 0) price = n;
  }
  if (price == null && validAddress(quote)) {
    const d = await dexPairs(quote);
    const p = bestPair(d.pairs);
    const n = numeric(p?.priceUsd);
    if (n != null && n > 0) price = n;
  }
  if (price != null) quotePriceCache.set(key, { price, at: Date.now() });
  return price;
}

async function ponsCurveMetrics(token, tokenMeta) {
  const launch = await readContract(CFG.ponsFactory, factoryAbi, 'getLaunchedToken', [getAddress(token)]);
  if (!launch?.exists) return { isPons: false };

  const curve = validAddress(launch.curve) ? launch.curve : '';
  const pairToken = validAddress(launch.pairToken) ? launch.pairToken : ZERO;
  const phase = Number(launch.phase ?? 0);
  const [reserves, qDecimals, qUsd, realQuote] = await Promise.all([
    curve && phase === 0 ? readContract(curve, curveAbi, 'getReserves') : Promise.resolve(null),
    quoteDecimals(pairToken),
    quoteUsd(pairToken),
    curve && phase === 0 ? readContract(curve, curveAbi, 'realQuoteReserve') : Promise.resolve(null),
  ]);

  let priceUsd = null;
  let marketCap = null;
  let reserveUsd = null;
  if (reserves && qDecimals != null && tokenMeta.decimals != null && qUsd != null) {
    const quoteReserve = Number(formatUnits(BigInt(reserves[0]), qDecimals));
    const tokenReserve = Number(formatUnits(BigInt(reserves[1]), tokenMeta.decimals));
    if (quoteReserve >= 0 && tokenReserve > 0) priceUsd = (quoteReserve / tokenReserve) * qUsd;
  }
  if (priceUsd != null && tokenMeta.totalSupply && tokenMeta.decimals != null) {
    const supply = Number(formatUnits(BigInt(tokenMeta.totalSupply), tokenMeta.decimals));
    if (Number.isFinite(supply)) marketCap = priceUsd * supply;
  }
  if (realQuote != null && qDecimals != null && qUsd != null) {
    const qr = Number(formatUnits(BigInt(realQuote), qDecimals));
    if (Number.isFinite(qr)) reserveUsd = qr * qUsd;
  }

  return {
    isPons: true,
    curve,
    pairToken,
    phase,
    priceUsd,
    marketCap,
    reserveUsd,
    creatorTaxBps: Number(launch.creatorTaxBps ?? 0),
    buybackEnabled: Boolean(launch.buybackEnabled),
    poolFee: Number(launch.poolFee ?? 0),
    deployer: validAddress(launch.deployer) ? launch.deployer : '',
  };
}

async function enrichJob(job) {
  const token = text(job.token_address);
  const payload = job.payload || {};

  const [chainMeta, blockscout, dex] = await Promise.all([
    onchainTokenMeta(token),
    blockscoutToken(token),
    dexPairs(token),
  ]);
  const pons = await ponsCurveMetrics(token, chainMeta);
  const pair = bestPair(dex.pairs, payload.pool || job.pool_key);
  const txns = pair?.txns?.m5 || {};
  const volume5m = numeric(pair?.volume?.m5);

  const explorerMeta = blockscout.meta.data || {};
  const meta = {
    symbol: chainMeta.symbol || text(explorerMeta.symbol),
    name: chainMeta.name || text(explorerMeta.name),
    decimals: chainMeta.decimals ?? numeric(explorerMeta.decimals),
    totalSupply: chainMeta.totalSupply || text(explorerMeta.total_supply ?? explorerMeta.totalSupply),
  };

  let priceUsd = numeric(pair?.priceUsd);
  let marketCap = numeric(pair?.marketCap);
  let fdv = numeric(pair?.fdv);
  if (priceUsd == null && pons.priceUsd != null) priceUsd = pons.priceUsd;
  if (marketCap == null && pons.marketCap != null) marketCap = pons.marketCap;
  if (fdv == null && pons.marketCap != null) fdv = pons.marketCap;

  const sources = [
    (meta.symbol || meta.name || meta.totalSupply) ? 'ONCHAIN_META_OK' : 'ONCHAIN_META_PENDING',
    CFG.blockscoutKey
      ? (blockscout.holders.ok ? 'HOLDERS_OK' : `HOLDERS_${blockscout.holders.status || 'ERR'}`)
      : 'HOLDERS_NO_KEY',
    pair ? 'DEX_OK' : (dex.ok ? 'DEX_PENDING' : `DEX_${dex.status || 'ERR'}`),
    pons.isPons ? (pons.priceUsd != null ? 'PONS_CURVE_OK' : `PONS_PHASE_${pons.phase}`) : 'DIRECT_POOL',
  ];
  const sourceStatus = sources.join('|');

  updateTokenEnrichment(token, meta);
  const snapshot = saveSnapshot(job, {
    priceUsd,
    marketCap,
    fdv,
    liquidityUsd: numeric(pair?.liquidity?.usd),
    buyCount: numeric(txns?.buys),
    sellCount: numeric(txns?.sells),
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    volumeTotalUsd: volume5m,
    holderCount: holderCount(blockscout.holders.data),
    dex: text(pair?.dexId) || (pons.isPons ? 'pons-curve' : ''),
    pairAddress: text(pair?.pairAddress) || pons.curve || text(payload.pool || job.pool_key),
    sourceStatus,
    raw: {
      metricWindow: 'dexscreener_m5_at_snapshot_time',
      payload,
      onchainMeta: chainMeta,
      pons,
      blockscoutMeta: blockscout.meta.data,
      blockscoutCounters: blockscout.holders.data,
      dexPair: pair,
    },
  });

  const risk = saveRiskChecks({
    snapshot,
    chainMeta,
    pons,
    pairToken: pons.pairToken || payload.pairToken || '',
    sourceStatus,
  });

  completeJob(job.job_id);
  return {
    jobId: job.job_id,
    type: job.job_type,
    token,
    snapshotType: snapshot.snapshot_type,
    price: snapshot.price_usd,
    marketCap: snapshot.market_cap,
    liquidity: snapshot.liquidity_usd,
    buys: snapshot.buy_count,
    sells: snapshot.sell_count,
    holders: snapshot.holder_count,
    priceChangePct: snapshot.price_change_pct,
    risk: risk.counts,
    status: snapshot.source_status,
  };
}

async function main() {
  const db = initializeDatabase();
  console.log('[job worker boot]', JSON.stringify({
    version: '2.6.0',
    pollMs: CFG.pollMs,
    blockscoutKeyConfigured: Boolean(CFG.blockscoutKey),
    ...db,
  }));

  while (true) {
    const job = claimDueJob();
    if (!job) {
      await sleep(CFG.pollMs);
      continue;
    }

    try {
      const result = await enrichJob(job);
      console.log('[job done]', JSON.stringify(result));
    } catch (err) {
      const failed = failJob(job.job_id, err?.message || err);
      console.error('[job error]', JSON.stringify({
        jobId: job.job_id,
        type: job.job_type,
        token: job.token_address,
        error: text(err?.message || err),
        ...failed,
      }));
    }
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch(err => {
  console.error('[job worker fatal]', err);
  console.error('[job worker health]', JSON.stringify(getDatabaseHealth()));
  process.exitCode = 1;
});
