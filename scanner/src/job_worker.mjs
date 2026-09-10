import {
  initializeDatabase,
  claimDueJob,
  completeJob,
  failJob,
  saveSnapshot,
  updateTokenEnrichment,
  getDatabaseHealth,
} from './db.mjs';

const CFG = {
  chain: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',
  blockscout: (process.env.BLOCKSCOUT_API_BASE || 'https://robinhoodchain.blockscout.com/api/v2').replace(/\/$/, ''),
  pollMs: Math.max(500, Number(process.env.JOB_POLL_MS || 1000)),
};

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

async function fetchJson(url, timeoutMs = 7000) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'rh-chain-monitor-job-worker/2.5' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: text(err?.message || err), data: null };
  }
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

function tokenMetadata(meta) {
  const m = meta || {};
  return {
    symbol: text(m.symbol),
    name: text(m.name),
    decimals: numeric(m.decimals),
    totalSupply: text(m.total_supply ?? m.totalSupply ?? m.total_supply_value),
  };
}

function holderCount(counters) {
  return numeric(counters?.token_holders_count ?? counters?.holders_count ?? counters?.holder_count);
}

async function enrichJob(job) {
  const token = text(job.token_address);
  const payload = job.payload || {};
  const [metaRes, holdersRes, dexRes] = await Promise.all([
    fetchJson(`${CFG.blockscout}/tokens/${token}`, 6000),
    fetchJson(`${CFG.blockscout}/tokens/${token}/counters`, 6000),
    fetchJson(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${token}`, 7000),
  ]);

  if (!metaRes.ok && !holdersRes.ok && !dexRes.ok) {
    throw new Error(`all enrichment sources unavailable meta=${metaRes.status} holders=${holdersRes.status} dex=${dexRes.status}`);
  }

  const meta = tokenMetadata(metaRes.data);
  const pair = bestPair(dexRes.data, payload.pool || job.pool_key);
  const txns = pair?.txns?.m5 || {};
  const volume5m = numeric(pair?.volume?.m5);
  const sources = [
    metaRes.ok ? 'META_OK' : `META_${metaRes.status || 'ERR'}`,
    holdersRes.ok ? 'HOLDERS_OK' : `HOLDERS_${holdersRes.status || 'ERR'}`,
    pair ? 'DEX_OK' : (dexRes.ok ? 'DEX_PENDING' : `DEX_${dexRes.status || 'ERR'}`),
  ];

  updateTokenEnrichment(token, meta);
  const snapshot = saveSnapshot(job, {
    priceUsd: numeric(pair?.priceUsd),
    marketCap: numeric(pair?.marketCap),
    fdv: numeric(pair?.fdv),
    liquidityUsd: numeric(pair?.liquidity?.usd),
    buyCount: numeric(txns?.buys),
    sellCount: numeric(txns?.sells),
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    volumeTotalUsd: volume5m,
    holderCount: holderCount(holdersRes.data),
    dex: text(pair?.dexId),
    pairAddress: text(pair?.pairAddress),
    sourceStatus: sources.join('|'),
    raw: {
      metricWindow: 'dexscreener_m5_at_snapshot_time',
      payload,
      meta: metaRes.data,
      counters: holdersRes.data,
      dexPair: pair,
    },
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
    status: snapshot.source_status,
  };
}

async function main() {
  const db = initializeDatabase();
  console.log('[job worker boot]', JSON.stringify({ version: '2.5.0', pollMs: CFG.pollMs, ...db }));

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
