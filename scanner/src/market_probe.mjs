import { createPublicClient, http, parseAbi, getAddress, formatUnits } from 'viem';

const ZERO = '0x0000000000000000000000000000000000000000';
const CFG = {
  chainId: 4663,
  rpc: process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chain: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',
  ponsFactory: process.env.PONS_V2_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  weth: String(process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase(),
};

const client = createPublicClient({
  chain: {
    id: CFG.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CFG.rpc] } },
  },
  transport: http(CFG.rpc, { timeout: 12_000, retryCount: 0 }),
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

const decimalsCache = new Map();
const quotePriceCache = new Map();

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function validAddress(v) { return /^0x[a-fA-F0-9]{40}$/.test(text(v)); }
function nativeQuote(v) { return !v || text(v).toLowerCase() === ZERO; }

async function fetchJson(url, timeoutMs = 7000) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'rh-history-probe/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function readContract(address, abi, functionName, args = []) {
  if (!validAddress(address)) return null;
  try {
    return await client.readContract({ address: getAddress(address), abi, functionName, args });
  } catch { return null; }
}

async function dexPairs(token) {
  const data = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${token}`);
  return Array.isArray(data) ? data : [];
}

function bestPair(pairs, preferredPool = '') {
  const preferred = text(preferredPool).toLowerCase();
  if (preferred) {
    const exact = pairs.find(p => text(p?.pairAddress).toLowerCase() === preferred);
    if (exact) return exact;
  }
  return [...pairs].sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;
}

async function quoteDecimals(quote) {
  if (nativeQuote(quote)) return 18;
  const key = text(quote).toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const value = await readContract(quote, erc20Abi, 'decimals');
  const n = value == null ? null : Number(value);
  if (n != null) decimalsCache.set(key, n);
  return n;
}

async function quoteUsd(quote) {
  const key = nativeQuote(quote) ? 'eth' : text(quote).toLowerCase();
  const cached = quotePriceCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  let price = null;
  if (nativeQuote(quote) || key === CFG.weth) {
    const data = await fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot', 5000);
    price = num(data?.data?.amount);
  }
  if (price == null && validAddress(quote)) {
    const pair = bestPair(await dexPairs(quote));
    price = num(pair?.priceUsd);
  }
  if (price != null && price > 0) quotePriceCache.set(key, { price, at: Date.now() });
  return price;
}

async function ponsMetrics(row) {
  if (!validAddress(row.token_address)) return null;
  const launch = await readContract(CFG.ponsFactory, factoryAbi, 'getLaunchedToken', [getAddress(row.token_address)]);
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
  if (!(quoteReserve >= 0) || !(tokenReserve > 0)) return null;
  const priceUsd = (quoteReserve / tokenReserve) * qUsd;
  let marketCap = null;
  let reserveUsd = null;
  if (realQuote != null) {
    const realQuoteValue = Number(formatUnits(BigInt(realQuote), qDecimals));
    if (Number.isFinite(realQuoteValue)) reserveUsd = realQuoteValue * qUsd;
  }
  if (row.total_supply) {
    try {
      const supply = Number(formatUnits(BigInt(row.total_supply), tokenDecimals));
      if (Number.isFinite(supply)) marketCap = priceUsd * supply;
    } catch {}
  }
  return {
    priceUsd,
    marketCap,
    liquidityUsd: null,
    reserveUsd,
    source: 'pons-curve',
    poolKey: text(launch.curve).toLowerCase(),
    pairSelection: 'pons-curve',
  };
}

export async function probeTokenMarket(row = {}) {
  const token = text(row.token_address).toLowerCase();
  if (!validAddress(token)) return null;
  const pair = bestPair(await dexPairs(token));
  const price = num(pair?.priceUsd);
  if (price != null && price > 0) {
    return {
      priceUsd: price,
      marketCap: num(pair?.marketCap) ?? num(pair?.fdv),
      liquidityUsd: num(pair?.liquidity?.usd),
      reserveUsd: null,
      source: text(pair?.dexId) || 'dexscreener',
      poolKey: text(pair?.pairAddress).toLowerCase() || text(row.first_pool_key).toLowerCase(),
      pairSelection: 'highest_liquidity',
    };
  }
  return ponsMetrics({ ...row, token_address: token });
}
