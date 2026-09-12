import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';
import { probeTokenMarket } from './market_probe.mjs';
import {
  ensureSignalOutcomeSchema,
  syncOutcomesFromAlerts,
  getOpenOutcomes,
  recordOutcomeSample,
  recomputeOutcome,
  recomputeOpenOutcomes,
} from './signal_outcomes.mjs';
import { getHistoryCalibrationRows } from './history_calibration.mjs';

const CFG = {
  pollMs: Math.max(10_000, Number(process.env.HISTORY_POLL_MS || 15_000)),
  maxActiveTokens: Math.max(5, Math.min(100, Number(process.env.HISTORY_MAX_ACTIVE_TOKENS || 50))),
  rpcGapMs: Math.max(100, Number(process.env.HISTORY_PROBE_GAP_MS || 300)),
};

let stopping = false;
let lastSummaryAt = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function parsedRaw(v) { try { return JSON.parse(String(v || '{}')); } catch { return {}; } }
function isShadow(row) { return text(row.event_type).startsWith('SHADOW_'); }

function ageMs(row, now = Date.now()) {
  const t = new Date(row.triggered_at).getTime();
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

function desiredSampleInterval(row) {
  const age = ageMs(row);
  if (isShadow(row)) {
    if (age < 60 * 60_000) return 2 * 60_000;
    if (age < 6 * 60 * 60_000) return 5 * 60_000;
    return 10 * 60_000;
  }
  if (age < 60 * 60_000) return 60_000;
  if (age < 6 * 60 * 60_000) return 3 * 60_000;
  return 5 * 60_000;
}

function sampleDue(row, now = Date.now()) {
  if (!row.last_sample_at) return true;
  const last = new Date(row.last_sample_at).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= desiredSampleInterval(row);
}

function latestFreshTick(token, shadow, now = Date.now()) {
  const db = getDatabase();
  const maxAge = shadow ? 5 * 60_000 : 2 * 60_000;
  const cutoff = new Date(now - maxAge).toISOString();
  const tick = db.prepare(`
    SELECT tick_at AS sampleAt,price_usd AS priceUsd,market_cap AS marketCap,
           liquidity_usd AS liquidityUsd,source,pool_key AS poolKey,raw_data
    FROM market_ticks
    WHERE token_address=? AND price_usd>0 AND tick_at>=?
    ORDER BY tick_at DESC LIMIT 1
  `).get(token, cutoff);
  if (!tick) return null;
  const raw = parsedRaw(tick.raw_data);
  return { ...tick, reserveUsd: num(raw?.reserveUsd), pairSelection: text(raw?.pairSelection), raw_data: undefined };
}

async function getMarketForGroup(rows) {
  const token = text(rows[0]?.token_address).toLowerCase();
  const shadowOnly = rows.every(isShadow);
  const cached = latestFreshTick(token, shadowOnly);
  if (cached) return { ...cached, cached: true };
  const market = await probeTokenMarket(rows[0]);
  if (!market?.priceUsd || market.priceUsd <= 0) return null;
  return { ...market, sampleAt: new Date().toISOString(), cached: false };
}

async function cycle() {
  const added = syncOutcomesFromAlerts();
  recomputeOpenOutcomes(new Date());
  const allOpen = getOpenOutcomes(5000);
  const due = allOpen.filter(row => sampleDue(row));
  const groups = new Map();
  for (const row of due) {
    const token = text(row.token_address).toLowerCase();
    if (!groups.has(token)) groups.set(token, []);
    groups.get(token).push(row);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const aReal = a[1].some(r => !isShadow(r)) ? 1 : 0;
    const bReal = b[1].some(r => !isShadow(r)) ? 1 : 0;
    if (aReal !== bReal) return bReal - aReal;
    const at = Math.min(...a[1].map(r => new Date(r.triggered_at).getTime() || Infinity));
    const bt = Math.min(...b[1].map(r => new Date(r.triggered_at).getTime() || Infinity));
    return at - bt;
  }).slice(0, CFG.maxActiveTokens);

  let sampledEvents = 0;
  let sampledTokens = 0;
  let failedTokens = 0;
  let cachedTokens = 0;
  for (const [, rows] of ordered) {
    if (stopping) break;
    try {
      const market = await getMarketForGroup(rows);
      if (!market) {
        failedTokens += 1;
      } else {
        sampledTokens += 1;
        if (market.cached) cachedTokens += 1;
        const sampleAt = market.sampleAt || new Date().toISOString();
        for (const row of rows) {
          recordOutcomeSample({
            eventKey: row.event_key,
            tokenAddress: row.token_address,
            sampleAt,
            priceUsd: market.priceUsd,
            marketCap: market.marketCap,
            liquidityUsd: market.liquidityUsd,
            reserveUsd: market.reserveUsd,
            poolKey: market.poolKey,
            pairSelection: market.pairSelection,
            source: market.source || (market.cached ? 'market-ticks-cache' : 'history-probe'),
          });
          recomputeOutcome(row.event_key, new Date());
          sampledEvents += 1;
        }
      }
    } catch (err) {
      failedTokens += 1;
      console.warn('[history worker sample]', JSON.stringify({
        address: rows[0]?.token_address,
        events: rows.length,
        error: text(err?.message || err).slice(0, 200),
      }));
    }
    if (CFG.rpcGapMs) await sleep(CFG.rpcGapMs);
  }

  if (added || sampledEvents || Date.now() - lastSummaryAt >= 5 * 60_000) {
    const calibration = getHistoryCalibrationRows();
    console.log('[history worker]', JSON.stringify({
      added,
      openEvents: allOpen.length,
      dueTokens: groups.size,
      sampledTokens,
      sampledEvents,
      cachedTokens,
      failedTokens,
      completedBuckets: calibration.length,
      at: new Date().toISOString(),
    }));
    lastSummaryAt = Date.now();
  }
}

async function main() {
  const status = initializeDatabase();
  ensureSignalOutcomeSchema();
  console.log('[history worker boot]', JSON.stringify({
    db: status.path,
    pollMs: CFG.pollMs,
    maxActiveTokens: CFG.maxActiveTokens,
    realSampling: '1m<1h,3m<6h,5m<24h',
    shadowSampling: '2m<1h,5m<6h,10m<24h',
    marketTickReuse: true,
  }));
  while (!stopping) {
    const started = Date.now();
    try { await cycle(); }
    catch (err) { console.error('[history worker cycle]', text(err?.stack || err)); }
    const wait = Math.max(1000, CFG.pollMs - (Date.now() - started));
    await sleep(wait);
  }
  closeDatabase();
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

main().catch(err => {
  console.error('[history worker fatal]', err);
  try { closeDatabase(); } catch {}
  process.exitCode = 1;
});
