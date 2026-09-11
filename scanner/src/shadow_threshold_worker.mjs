import { initializeDatabase, closeDatabase } from './db.mjs';
import { ensureOpportunitySchema } from './opportunity_repository.mjs';
import { ensureShadowThresholdSchema, syncShadowThresholdPool } from './shadow_threshold_pool.mjs';

const POLL_MS = Math.max(10_000, Number(process.env.SHADOW_POLL_MS || 30_000));
let stopping = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const status = initializeDatabase();
  ensureOpportunitySchema();
  ensureShadowThresholdSchema();
  console.log('[shadow threshold boot]', JSON.stringify({ db: status.path, pollMs: POLL_MS }));
  while (!stopping) {
    const started = Date.now();
    try {
      const result = syncShadowThresholdPool();
      if (result.created || result.promoted || result.left) console.log('[shadow threshold]', JSON.stringify({ ...result, at: new Date().toISOString() }));
    } catch (err) {
      console.error('[shadow threshold cycle]', String(err?.stack || err));
    }
    await sleep(Math.max(1000, POLL_MS - (Date.now() - started)));
  }
  closeDatabase();
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

main().catch(err => {
  console.error('[shadow threshold fatal]', err);
  try { closeDatabase(); } catch {}
  process.exitCode = 1;
});
