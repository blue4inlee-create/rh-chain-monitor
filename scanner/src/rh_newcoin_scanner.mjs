import http from 'node:http';
import { appendFile } from 'node:fs/promises';
import {
  createPublicClient, http as viemHttp, parseAbiItem, decodeEventLog,
  decodeAbiParameters, getAddress,
} from 'viem';

const CFG = {
  chainId: 4663,
  rpcUrl: process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com',
  pollMs: Number(process.env.POLL_MS || 3000),
  heartbeatMs: Number(process.env.HEARTBEAT_MS || 60000),
  backfillBlocks: Number(process.env.BACKFILL_BLOCKS || 120),
  port: Number(process.env.PORT || 3000),
  dryRun: String(process.env.DRY_RUN || '').toLowerCase() === 'true',
  webhookUrl: String(process.env.SHEET_WEBHOOK_URL || '').trim(),
  webhookSecret: String(process.env.SHEET_INGEST_SECRET || '').trim(),
  enrichQueuePath: String(process.env.ENRICH_QUEUE_PATH || '/tmp/rh_enrich_queue.jsonl'),
  ponsV2Factory: norm(process.env.PONS_V2_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  v4PoolManager: norm(process.env.UNIV4_POOL_MANAGER || '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  v3Factory: norm(process.env.UNIV3_FACTORY || ''),
  weth: norm(process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
};

const QUOTES = new Set(
  [CFG.weth, ...(process.env.QUOTE_TOKENS || '').split(',').map(norm)]
    .filter(Boolean).map((x) => x.toLowerCase())
);

const PONS_TOKEN_LAUNCHED_TOPIC = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const PONS_POOL_GRADUATED_TOPIC = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259';
const V4_INIT = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const V3_POOL_CREATED = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)');

const client = createPublicClient({
  chain: {
    id: CFG.chainId, name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CFG.rpcUrl] } },
  },
  transport: viemHttp(CFG.rpcUrl, { timeout: 15000, retryCount: 1 }),
});

const state = {
  startedAt: new Date().toISOString(), lastBlock: null, lastPollAt: null,
  lastHeartbeatAt: null, lastEventAt: null, eventsSeen: 0,
  webhookOk: 0, webhookFail: 0, queueWrites: 0, queueErrors: 0,
  rawOutbox: 0, lastError: null,
};
const seen = new Map();
const rawOutbox = [];
let rawWebhookActive = 0;
let queueWriteTail = Promise.resolve();

function norm(v) {
  const s = String(v || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s) ? s : '';
}
function topicAddress(topic) {
  return topic && topic.length === 66 ? norm('0x' + topic.slice(26)) : '';
}
function isQuote(addr) { return addr && QUOTES.has(addr.toLowerCase()); }
function tokenFromPair(a, b) {
  if (isQuote(a) && !isQuote(b)) return b;
  if (isQuote(b) && !isQuote(a)) return a;
  return '';
}
function deDupeKey(payload) {
  return [payload.stage, payload.tokenCa, payload.pool, payload.txHash]
    .filter(Boolean).join('|').toLowerCase();
}
function shouldEmit(payload) {
  const k = deDupeKey(payload);
  if (!k) return true;
  const now = Date.now(), prev = seen.get(k) || 0;
  if (now - prev < 15 * 60 * 1000) return false;
  seen.set(k, now);
  if (seen.size > 5000) {
    for (const [key, ts] of seen) if (now - ts > 6 * 60 * 60 * 1000) seen.delete(key);
  }
  return true;
}

async function postWebhook(payload) {
  const body = { ...payload, secret: CFG.webhookSecret };
  if (CFG.dryRun || !CFG.webhookUrl || !CFG.webhookSecret) {
    console.log('[event]', JSON.stringify({ ...payload, webhook: CFG.dryRun ? 'dry-run' : 'not-configured' }));
    return { ok: true, skipped: true };
  }
  try {
    const res = await fetch(CFG.webhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!res.ok || (parsed && parsed.ok === false)) throw new Error(`webhook ${res.status}: ${text.slice(0, 300)}`);
    state.webhookOk++;
    return { ok: true };
  } catch (err) {
    state.webhookFail++;
    state.lastError = String(err?.message || err);
    if (state.webhookFail <= 5 || state.webhookFail % 25 === 0) console.error('[webhook]', state.lastError, `fail=${state.webhookFail}`);
    return { ok: false, error: state.lastError };
  }
}

function pumpRawWebhooks() {
  while (rawWebhookActive < 2 && rawOutbox.length) {
    const payload = rawOutbox.shift();
    rawWebhookActive++;
    state.rawOutbox = rawOutbox.length;
    postWebhook(payload).finally(() => {
      rawWebhookActive--;
      state.rawOutbox = rawOutbox.length;
      setImmediate(pumpRawWebhooks);
    });
  }
}
function enqueueRawWebhook(payload) {
  if (rawOutbox.length >= 5000) {
    state.lastError = 'raw webhook outbox full';
    console.error('[webhook] outbox full; dropping oldest raw event');
    rawOutbox.shift();
  }
  rawOutbox.push(payload);
  state.rawOutbox = rawOutbox.length;
  pumpRawWebhooks();
}

function appendEnrichmentQueue(payload) {
  const item = {
    source: payload.source || 'Robinhood Chain',
    firstSeen: payload.firstSeen || new Date().toISOString(),
    lastUpdate: payload.lastUpdate || new Date().toISOString(),
    stage: payload.stage || '', tokenCa: payload.tokenCa || '',
    pool: payload.pool || '', deployer: payload.deployer || '',
    pairToken: payload.pairToken || '', pairType: payload.pairType || '',
    txHash: payload.txHash || '', block: Number(payload.block || 0),
    notes: payload.notes || '',
  };
  if (!item.tokenCa) return Promise.resolve();
  queueWriteTail = queueWriteTail
    .then(() => appendFile(CFG.enrichQueuePath, JSON.stringify(item) + '\n', 'utf8'))
    .then(() => { state.queueWrites++; })
    .catch((err) => {
      state.queueErrors++;
      state.lastError = `queue: ${String(err?.message || err)}`;
      console.error('[queue]', state.lastError);
    });
  return queueWriteTail;
}

async function emit(payload) {
  if (!shouldEmit(payload)) return;
  state.eventsSeen++;
  state.lastEventAt = new Date().toISOString();
  const event = {
    source: payload.source || 'Robinhood Chain',
    firstSeen: payload.firstSeen || new Date().toISOString(),
    lastUpdate: new Date().toISOString(), ...payload,
  };
  await appendEnrichmentQueue(event);
  enqueueRawWebhook(event);
}

function baseLogPayload(log) {
  return { block: Number(log.blockNumber || 0n), txHash: log.transactionHash || '', firstSeen: new Date().toISOString() };
}

async function scanPonsV2(fromBlock, toBlock) {
  if (!CFG.ponsV2Factory) return;
  const logs = await client.getLogs({ address: getAddress(CFG.ponsV2Factory), fromBlock, toBlock });
  for (const log of logs) {
    const topic0 = String(log.topics?.[0] || '').toLowerCase();
    if (topic0 === PONS_TOKEN_LAUNCHED_TOPIC) {
      const token = topicAddress(log.topics?.[1]);
      const curve = topicAddress(log.topics?.[2]);
      const deployer = topicAddress(log.topics?.[3]);
      let pairToken = '';
      try {
        const decoded = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], log.data || '0x');
        pairToken = norm(decoded?.[0]);
      } catch {}
      if (!token) continue;
      await emit({ ...baseLogPayload(log), source: 'Pons V2', stage: 'TokenLaunched',
        tokenCa: token, pool: curve, deployer, pairToken,
        pairType: isQuote(pairToken) ? 'Quote' : '', enrichment: 'raw-chain' });
    } else if (topic0 === PONS_POOL_GRADUATED_TOPIC) {
      const token = topicAddress(log.topics?.[1]);
      if (!token) continue;
      await emit({ ...baseLogPayload(log), source: 'Pons V2', stage: 'PoolGraduated', tokenCa: token, enrichment: 'raw-chain' });
    }
  }
}

async function scanV4(fromBlock, toBlock) {
  if (!CFG.v4PoolManager) return;
  const logs = await client.getLogs({ address: getAddress(CFG.v4PoolManager), event: V4_INIT, fromBlock, toBlock });
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: [V4_INIT], data: log.data, topics: log.topics });
      const a = norm(decoded.args.currency0), b = norm(decoded.args.currency1);
      const token = tokenFromPair(a, b);
      if (!token) continue;
      const quote = isQuote(a) ? a : b;
      await emit({ ...baseLogPayload(log), source: 'Uniswap V4', stage: 'V4 PoolInitialized',
        tokenCa: token, pool: String(decoded.args.id || ''), pairToken: quote, pairType: 'V4',
        notes: `hook=${decoded.args.hooks}; fee=${decoded.args.fee}; tickSpacing=${decoded.args.tickSpacing}`,
        enrichment: 'raw-chain' });
    } catch (err) { console.warn('[v4 decode]', String(err?.message || err)); }
  }
}

async function scanV3(fromBlock, toBlock) {
  if (!CFG.v3Factory) return;
  const logs = await client.getLogs({ address: getAddress(CFG.v3Factory), event: V3_POOL_CREATED, fromBlock, toBlock });
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: [V3_POOL_CREATED], data: log.data, topics: log.topics });
      const a = norm(decoded.args.token0), b = norm(decoded.args.token1);
      const token = tokenFromPair(a, b);
      if (!token) continue;
      const quote = isQuote(a) ? a : b;
      await emit({ ...baseLogPayload(log), source: 'Uniswap V3', stage: 'V3 PoolCreated',
        tokenCa: token, pool: norm(decoded.args.pool), pairToken: quote, pairType: 'V3',
        notes: `fee=${decoded.args.fee}; tickSpacing=${decoded.args.tickSpacing}`, enrichment: 'raw-chain' });
    } catch (err) { console.warn('[v3 decode]', String(err?.message || err)); }
  }
}

async function scanRange(fromBlock, toBlock) {
  const jobs = [
    ['pons-v2', () => scanPonsV2(fromBlock, toBlock)],
    ['v4', () => scanV4(fromBlock, toBlock)],
    ['v3', () => scanV3(fromBlock, toBlock)],
  ];
  for (const [name, fn] of jobs) {
    try { await fn(); }
    catch (err) {
      state.lastError = `${name}: ${String(err?.message || err)}`;
      console.error('[scan]', state.lastError);
      if (state.lastError.includes('429')) await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

function heartbeat() {
  state.lastHeartbeatAt = new Date().toISOString();
  if (rawOutbox.length > 50) return;
  enqueueRawWebhook({
    kind: 'heartbeat', heartbeat: state.lastHeartbeatAt, latestBlock: state.lastBlock,
    provider: 'Robinhood RPC polling',
    listeners: { 'Pons V2': Boolean(CFG.ponsV2Factory), 'Uniswap V4': Boolean(CFG.v4PoolManager), 'Uniswap V3': Boolean(CFG.v3Factory) },
  });
}

async function mainLoop() {
  let latest = await client.getBlockNumber();
  let cursor = latest > BigInt(CFG.backfillBlocks) ? latest - BigInt(CFG.backfillBlocks) : 0n;
  state.lastBlock = Number(cursor);
  console.log('[boot]', JSON.stringify({
    version: '2.2.0', chainId: CFG.chainId, rpc: CFG.rpcUrl, backfillBlocks: CFG.backfillBlocks,
    webhookConfigured: Boolean(CFG.webhookUrl && CFG.webhookSecret), dryRun: CFG.dryRun,
    enrichQueue: CFG.enrichQueuePath, ponsV2Factory: CFG.ponsV2Factory,
    v4PoolManager: CFG.v4PoolManager, v3Factory: CFG.v3Factory || null, quoteTokens: [...QUOTES],
  }));

  while (true) {
    try {
      latest = await client.getBlockNumber();
      state.lastPollAt = new Date().toISOString();
      if (latest > cursor) {
        let from = cursor + 1n;
        while (from <= latest) {
          const to = from + 1999n < latest ? from + 1999n : latest;
          await scanRange(from, to);
          cursor = to;
          state.lastBlock = Number(cursor);
          from = to + 1n;
        }
      }
    } catch (err) {
      state.lastError = String(err?.message || err);
      console.error('[poll]', state.lastError);
      if (state.lastError.includes('429')) await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({
      ok: true, service: 'rh-newcoin-scanner', version: '2.2.0', ...state,
      webhookConfigured: Boolean(CFG.webhookUrl && CFG.webhookSecret), dryRun: CFG.dryRun,
    });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(CFG.port, '0.0.0.0', () => console.log(`[health] listening on :${CFG.port}`));
setInterval(() => heartbeat(), CFG.heartbeatMs).unref();
heartbeat();
mainLoop().catch((err) => { console.error('[fatal]', err); process.exitCode = 1; });
