import { initializeDatabase, closeDatabase } from './db.mjs';
import { probeTokenMarket } from './market_probe.mjs';
import {
  ensureSignalOutcomeSchema,
  syncOutcomesFromAlerts,
  getOpenOutcomes,
  recordOutcomeSample,
  recomputeOutcome,
  recomputeOpenOutcomes,
  getCalibrationRows,
} from './signal_outcomes.mjs';

const CFG = {
  pollMs: Math.max(10_000, Number(process.env.HISTORY_POLL_MS || 15_000)),
  maxActive: Math.max(1, Math.min(50, Number(process.env.HISTORY_MAX_ACTIVE || 20))),
  rpcGapMs: Math.max(100, Number(process.env.HISTORY_PROBE_GAP_MS || 300)),
};

let stopping = false;
let lastSummaryAt = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function text(v) { return v == null ? '' : String(v).trim(); }

function ageMs(row, now = Date.now()) {
  const t = new Date(row.triggered_at).getTime();
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

function desiredSampleInterval(row) {
  const age = ageMs(row);
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

async function sampleOutcome(row) {
  const market = await probeTokenMarket(row);
  if (!market?.priceUsd || market.priceUsd <= 0) return { ok: false, reason: 'market_unavailable' };
  const sampleAt = new Date().toISOString();
  recordOutcomeSample({
    eventKey: row.event_key,
    tokenAddress: row.token_address,
    sampleAt,
    priceUsd: market.priceUsd,
    marketCap: market.marketCap,
    liquidityUsd: market.liquidityUsd,
    source: market.source,
  });
  const updated = recomputeOutcome(row.event_key, new Date());
  return { ok: true, market, updated };
}

async function cycle() {
  const added = syncOutcomesFromAlerts();
  recomputeOpenOutcomes(new Date());
  const open = getOpenOutcomes(CFG.maxActive);
  let sampled = 0;
  let failed = 0;
  for (const row of open) {
    if (stopping) break;
    if (!sampleDue(row)) continue;
    try {
      const result = await sampleOutcome(row);
      if (result.ok) sampled += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.warn('[history worker sample]', JSON.stringify({
        symbol: row.symbol,
        address: row.token_address,
        error: text(err?.message || err).slice(0, 200),
      }));
    }
    if (CFG.rpcGapMs) await sleep(CFG.rpcGapMs);
  }

  if (added || sampled || Date.now() - lastSummaryAt >= 5 * 60_000) {
    const calibration = getCalibrationRows();
    console.log('[history worker]', JSON.stringify({
      added,
      open: open.length,
      sampled,
      failed,
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
    maxActive: CFG.maxActive,
    adaptiveSampling: '1m<1h,3m<6h,5m<24h',
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
