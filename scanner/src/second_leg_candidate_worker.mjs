import { writeFile, rename } from 'node:fs/promises';
import { initializeDatabase, closeDatabase } from './db.mjs';
import {
  syncSecondLegCandidates,
  getSecondLegCandidateWatchlist,
  SECOND_LEG_CANDIDATE_DEFAULTS,
} from './second_leg_candidates.mjs';

const CFG = {
  pollMs: Math.max(30_000, Number(process.env.SECOND_LEG_CANDIDATE_POLL_MS || 120_000)),
  manualPath: String(process.env.SECOND_LEG_MANUAL_WATCHLIST || new URL('../config/second_leg_watchlist.json', import.meta.url).pathname),
  generatedPath: String(process.env.SECOND_LEG_GENERATED_WATCHLIST || '/data/second_leg_watchlist.generated.json'),
};

let stopping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writeGeneratedWatchlist(rows) {
  const payload = rows.map(r => ({
    symbol: r.symbol,
    address: r.address,
    preferredPair: r.preferredPair,
    athPriceUsd: r.athPriceUsd,
    fallbackRiskGate: r.fallbackRiskGate,
    enabled: true,
    candidateSource: r.candidateSource,
    peakMultiple: r.peakMultiple,
    manualOverride: r.manualOverride,
  }));
  const tmp = `${CFG.generatedPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, CFG.generatedPath);
  return payload.length;
}

export async function runSecondLegCandidateCycle() {
  initializeDatabase();
  const r = await syncSecondLegCandidates({ manualPath: CFG.manualPath });
  const watchlist = getSecondLegCandidateWatchlist(SECOND_LEG_CANDIDATE_DEFAULTS.maxScanCandidates);
  const generated = await writeGeneratedWatchlist(watchlist);
  const out = { ...r, generated, generatedPath: CFG.generatedPath };
  console.log('[second-leg candidate cycle]', JSON.stringify(out));
  return out;
}

async function main() {
  initializeDatabase();
  console.log('[second-leg candidate worker boot]', JSON.stringify({
    pollMs: CFG.pollMs,
    minAgeMs: SECOND_LEG_CANDIDATE_DEFAULTS.minAgeMs,
    minPeakMultiple: SECOND_LEG_CANDIDATE_DEFAULTS.minPeakMultiple,
    minLiquidity: SECOND_LEG_CANDIDATE_DEFAULTS.minLiquidity,
    maxScanCandidates: SECOND_LEG_CANDIDATE_DEFAULTS.maxScanCandidates,
    generatedPath: CFG.generatedPath,
  }));
  while (!stopping) {
    const started = Date.now();
    try { await runSecondLegCandidateCycle(); }
    catch (e) { console.error('[second-leg candidate worker]', e?.stack || e); }
    if (!stopping) await sleep(Math.max(1_000, CFG.pollMs - (Date.now() - started)));
  }
}

function requestShutdown() {
  stopping = true;
}
process.on('SIGTERM', requestShutdown);
process.on('SIGINT', requestShutdown);

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--once')) {
    runSecondLegCandidateCycle()
      .finally(() => { try { closeDatabase(); } catch {} });
  } else {
    main()
      .catch(e => { console.error('[second-leg candidate fatal]', e?.stack || e); process.exitCode = 1; })
      .finally(() => { try { closeDatabase(); } catch {} });
  }
}
