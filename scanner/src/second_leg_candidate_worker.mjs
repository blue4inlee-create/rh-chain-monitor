import { initializeDatabase, closeDatabase } from './db.mjs';
import { syncSecondLegCandidates, SECOND_LEG_CANDIDATE_DEFAULTS } from './second_leg_candidates.mjs';

const CFG = {
  pollMs: Math.max(30_000, Number(process.env.SECOND_LEG_CANDIDATE_POLL_MS || 120_000)),
  manualPath: String(process.env.SECOND_LEG_WATCHLIST || new URL('../config/second_leg_watchlist.json', import.meta.url).pathname),
};

let stopping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runSecondLegCandidateCycle() {
  initializeDatabase();
  const r = await syncSecondLegCandidates({ manualPath: CFG.manualPath });
  console.log('[second-leg candidate cycle]', JSON.stringify(r));
  return r;
}

async function main() {
  initializeDatabase();
  console.log('[second-leg candidate worker boot]', JSON.stringify({
    pollMs: CFG.pollMs,
    minAgeMs: SECOND_LEG_CANDIDATE_DEFAULTS.minAgeMs,
    minPeakMultiple: SECOND_LEG_CANDIDATE_DEFAULTS.minPeakMultiple,
    minLiquidity: SECOND_LEG_CANDIDATE_DEFAULTS.minLiquidity,
    maxScanCandidates: SECOND_LEG_CANDIDATE_DEFAULTS.maxScanCandidates,
  }));
  while (!stopping) {
    const started = Date.now();
    try { await runSecondLegCandidateCycle(); }
    catch (e) { console.error('[second-leg candidate worker]', e?.stack || e); }
    await sleep(Math.max(1_000, CFG.pollMs - (Date.now() - started)));
  }
}

function shutdown() {
  stopping = true;
  try { closeDatabase(); } catch {}
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--once')) runSecondLegCandidateCycle().finally(shutdown);
  else main().catch(e => { console.error('[second-leg candidate fatal]', e?.stack || e); process.exitCode = 1; });
}
