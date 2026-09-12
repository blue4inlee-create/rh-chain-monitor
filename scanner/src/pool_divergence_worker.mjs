import Database from 'better-sqlite3';
import { writeFile, rename } from 'node:fs/promises';

const CFG = {
  dbPath: String(process.env.SQLITE_PATH || '/data/rh_monitor.db'),
  chain: String(process.env.DEXSCREENER_CHAIN_ID || 'robinhood'),
  pollMs: Math.max(300_000, Number(process.env.POOL_DIVERGENCE_POLL_MS || 900_000)),
  minStoredMultiple: Math.max(1, Number(process.env.POOL_DIVERGENCE_MIN_MULTIPLE || 3)),
  inflationThreshold: Math.max(1.1, Number(process.env.POOL_DIVERGENCE_INFLATION || 2)),
  maxTokens: Math.max(10, Math.min(200, Number(process.env.POOL_DIVERGENCE_MAX_TOKENS || 100))),
  requestGapMs: Math.max(50, Number(process.env.POOL_DIVERGENCE_REQUEST_GAP_MS || 120)),
  outputPath: String(process.env.POOL_DIVERGENCE_STATUS_PATH || '/data/pool_divergence_audit.json'),
};

let stopping = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const lower = v => String(v || '').trim().toLowerCase();

async function fetchPairs(token) {
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${token}`, {
      headers: { accept: 'application/json', 'user-agent': 'rh-pool-divergence/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function canonicalPair(pairs = []) {
  return pairs
    .filter(p => (num(p?.priceUsd) || 0) > 0)
    .sort((a, b) => (num(b?.liquidity?.usd) || 0) - (num(a?.liquidity?.usd) || 0))[0] || null;
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function runPoolDivergenceAudit() {
  const db = new Database(CFG.dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  try {
    const tokens = db.prepare(`
      SELECT token_address,symbol,discovery_price_usd,max_multiple_discovery,max_multiple_canary,\n             current_price_usd,current_price_at,ath_price_usd,ath_price_at
      FROM tokens
      WHERE max_multiple_discovery >= ? AND discovery_price_usd > 0
      ORDER BY max_multiple_discovery DESC
      LIMIT ?
    `).all(CFG.minStoredMultiple, CFG.maxTokens);

    const anomalies = [];
    let checked = 0;
    let noPair = 0;
    let unverifiable = 0;
    for (const row of tokens) {
      if (stopping) break;
      const pairs = await fetchPairs(row.token_address);
      const pair = canonicalPair(pairs);
      if (!pair) { noPair++; await sleep(CFG.requestGapMs); continue; }
      const pool = lower(pair.pairAddress);
      const tick = db.prepare(`
        SELECT MAX(price_usd) max_price, COUNT(*) samples
        FROM market_ticks
        WHERE token_address=? AND lower(pool_key)=? AND price_usd>0
      `).get(row.token_address, pool) || {};
      const snap = db.prepare(`
        SELECT MAX(price_usd) max_price, COUNT(*) samples
        FROM snapshots
        WHERE token_address=? AND lower(pair_address)=?
          AND price_usd>0 AND market_cap>=100
      `).get(row.token_address, pool) || {};
      const livePrice = num(pair.priceUsd) || 0;
      const observedMax = Math.max(num(tick.max_price) || 0, num(snap.max_price) || 0, livePrice);
      const baseline = num(row.discovery_price_usd);
      const verified = observedMax > 0 && baseline > 0 ? observedMax / baseline : null;
      const stored = num(row.max_multiple_discovery);
      const inflation = verified > 0 && stored != null ? stored / verified : null;

      // Historical max is only actionable when the exact ATH observation is still
      // retained. Retention can remove old ticks; missing history must not become a
      // false corruption alert.
      let athEvidence = null;
      if (row.ath_price_at) {
        const athTick = db.prepare(`
          SELECT tick_at at, price_usd price, pool_key pool, 'tick' source
          FROM market_ticks WHERE token_address=? AND tick_at=? LIMIT 1
        `).get(row.token_address, row.ath_price_at);
        const athSnap = athTick ? null : db.prepare(`
          SELECT snapshot_at at, price_usd price, pair_address pool, 'snapshot' source
          FROM snapshots WHERE token_address=? AND snapshot_at=? LIMIT 1
        `).get(row.token_address, row.ath_price_at);
        athEvidence = athTick || athSnap || null;
      }

      const historicalMismatch = Boolean(
        inflation != null && inflation > CFG.inflationThreshold
        && athEvidence && lower(athEvidence.pool) && lower(athEvidence.pool) !== pool
      );
      const currentAgeMs = row.current_price_at ? Date.now() - new Date(row.current_price_at).getTime() : Infinity;
      const currentRatio = livePrice > 0 && num(row.current_price_usd) > 0
        ? Math.max(num(row.current_price_usd) / livePrice, livePrice / num(row.current_price_usd)) : null;
      const currentMismatch = Boolean(
        currentRatio != null && currentRatio > CFG.inflationThreshold
        && Number.isFinite(currentAgeMs) && currentAgeMs <= 20 * 60_000
      );

      checked++;
      if (inflation != null && inflation > CFG.inflationThreshold && !athEvidence) unverifiable++;
      if (historicalMismatch || currentMismatch) {
        anomalies.push({
          symbol: row.symbol || '', tokenAddress: row.token_address,
          reason: historicalMismatch ? 'historical_cross_pool_ath' : 'recent_current_pool_mismatch',
          storedMultiple: stored, verifiedMultiple: verified, inflation,
          storedCurrentPrice: num(row.current_price_usd), currentRatio,
          canonicalPair: pool, liquidityUsd: num(pair?.liquidity?.usd),
          volume24hUsd: num(pair?.volume?.h24), livePrice,
          canonicalObservedMax: observedMax,
          athEvidence: athEvidence ? { source: athEvidence.source, pool: lower(athEvidence.pool), price: num(athEvidence.price), at: athEvidence.at } : null,
          tickSamples: Number(tick.samples || 0), snapshotSamples: Number(snap.samples || 0),
        });
      }
      await sleep(CFG.requestGapMs);
    }
    const status = {
      ok: anomalies.length === 0,
      generatedAt: new Date().toISOString(),
      config: { minStoredMultiple: CFG.minStoredMultiple, inflationThreshold: CFG.inflationThreshold, maxTokens: CFG.maxTokens },
      scanned: tokens.length, checked, noPair, unverifiable,
      anomalyCount: anomalies.length,
      anomalies: anomalies.sort((a, b) => b.inflation - a.inflation),
    };
    await writeJsonAtomic(CFG.outputPath, status);
    console.log('[pool divergence audit]', JSON.stringify({ ok: status.ok, scanned: status.scanned, checked, noPair, unverifiable, anomalies: anomalies.length, outputPath: CFG.outputPath }));
    if (anomalies.length) console.error('[pool divergence anomalies]', JSON.stringify(anomalies.slice(0, 10)));
    return status;
  } finally { db.close(); }
}

async function main() {
  const once = process.argv.includes('--once');
  console.log('[pool divergence boot]', JSON.stringify({ pollMs: CFG.pollMs, minStoredMultiple: CFG.minStoredMultiple, inflationThreshold: CFG.inflationThreshold, maxTokens: CFG.maxTokens, outputPath: CFG.outputPath }));
  do {
    const started = Date.now();
    try { await runPoolDivergenceAudit(); }
    catch (err) { console.error('[pool divergence worker]', err?.stack || err); }
    if (once) break;
    await sleep(Math.max(1000, CFG.pollMs - (Date.now() - started)));
  } while (!stopping);
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error('[pool divergence fatal]', err?.stack || err); process.exitCode = 1; });
