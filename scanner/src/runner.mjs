import { spawn } from 'node:child_process';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { initializeDatabase, closeDatabase } from './db.mjs';
import { initializeDeadLetterStore, getDeadLetterStats } from './dead_letter.mjs';
import { ensurePriceMilestoneSchema, getPriceMilestoneHealth } from './price_milestones.mjs';
import { ensureAthSchema, getAthHealth } from './ath_metrics.mjs';
import { startPersistenceProxy } from './persistence_proxy.mjs';
import { ensureOpsSchema, recordOpsEvent, writeRuntimeStatus } from './ops_status.mjs';

const VERSION = '2.13.0';
const ROOT = new URL('.', import.meta.url);
const QUEUE_PATH = process.env.ENRICH_QUEUE_PATH || '/tmp/rh_enrich_queue.jsonl';
const OFFSET_PATH = process.env.ENRICH_OFFSET_PATH || '/tmp/rh_enrich_queue.offset';
const VOLUME_PROBE_PATH = process.env.VOLUME_PROBE_PATH || '/data/volume_probe.json';
const PERSIST_PROXY_PORT = Number(process.env.PERSIST_PROXY_PORT || 3101);
const UPSTREAM_SHEET_WEBHOOK_URL = String(process.env.SHEET_WEBHOOK_URL || '').trim();
const RESULT_SHEET_WEBHOOK_URL = String(process.env.RESULT_SHEET_WEBHOOK_URL || '').trim();
const UPSTREAM_SHEET_SECRET = String(process.env.SHEET_INGEST_SECRET || '').trim();
const LOCAL_PERSIST_SECRET = 'sqlite-local-ingest';
const LEGACY_ENRICHER = /^(1|true|yes)$/i.test(String(process.env.LEGACY_ENRICHER_ENABLED || 'false'));
let stopping = false;
let enricher = null;
let jobWorker = null;
let marketTracker = null;
let sheetSync = null;
let persistenceProxy = null;
let runtimeTimer = null;

function spawnNode(file, label, extraEnv = {}) {
  const child = spawn(process.execPath, [new URL(file, ROOT).pathname], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ENRICH_QUEUE_PATH: QUEUE_PATH,
      ENRICH_OFFSET_PATH: OFFSET_PATH,
      LEGACY_ENRICHER_ENABLED: LEGACY_ENRICHER ? 'true' : 'false',
      ...extraEnv,
    },
  });
  child.on('error', (err) => {
    console.error(`[runner ${label}] spawn error`, err);
    try { recordOpsEvent({ level:'ERROR', component:label, event:'spawn_error', message:String(err?.message || err) }); } catch {}
  });
  return child;
}

function startEnricher() {
  if (stopping || !LEGACY_ENRICHER) return;
  enricher = spawnNode('enricher.mjs', 'enricher');
  enricher.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[runner enricher] stopped code=${code ?? ''} signal=${signal || ''}`);
      return;
    }
    console.error(`[runner enricher] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'enricher', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startEnricher, 5000).unref();
  });
}

function startJobWorker() {
  if (stopping) return;
  jobWorker = spawnNode('job_worker.mjs', 'job-worker');
  jobWorker.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[runner job-worker] stopped code=${code ?? ''} signal=${signal || ''}`);
      return;
    }
    console.error(`[runner job-worker] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'job-worker', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startJobWorker, 5000).unref();
  });
}

function startMarketTracker() {
  if (stopping) return;
  marketTracker = spawnNode('canary_market_tracker.mjs', 'canary-market-tracker');
  marketTracker.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[runner canary-market-tracker] stopped code=${code ?? ''} signal=${signal || ''}`);
      return;
    }
    console.error(`[runner canary-market-tracker] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'canary-market-tracker', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startMarketTracker, 5000).unref();
  });
}

function startSheetSync() {
  if (stopping || !RESULT_SHEET_WEBHOOK_URL || !UPSTREAM_SHEET_SECRET) return;
  sheetSync = spawnNode('sheet_sync.mjs', 'sheet-sync', {
    RESULT_SHEET_WEBHOOK_URL,
    SHEET_WEBHOOK_URL: '',
  });
  sheetSync.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[runner sheet-sync] stopped code=${code ?? ''} signal=${signal || ''}`);
      return;
    }
    console.error(`[runner sheet-sync] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'sheet-sync', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startSheetSync, 5000).unref();
  });
}

function workerStatus() {
  const alive = child => Boolean(child && child.exitCode == null && !child.killed);
  return {
    scanner: true,
    jobWorker: alive(jobWorker),
    canaryMarketTracker: alive(marketTracker),
    legacyEnricher: LEGACY_ENRICHER ? alive(enricher) : false,
    sheetSync: RESULT_SHEET_WEBHOOK_URL ? alive(sheetSync) : false,
  };
}

async function refreshRuntimeStatus() {
  try {
    await writeRuntimeStatus({
      version: VERSION,
      workers: workerStatus(),
      sheetSync: {
        configured: Boolean(RESULT_SHEET_WEBHOOK_URL && UPSTREAM_SHEET_SECRET),
        intervalMs: Number(process.env.SHEET_SYNC_INTERVAL_MS || 300000),
      },
      config: {
        sqliteFirst: true,
        sqliteJobs: true,
        persistentCursor: true,
        deadLetters: true,
        priceMilestones: true,
        athTracking: true,
        legacyEnricher: LEGACY_ENRICHER,
      },
    });
  } catch (err) {
    console.error('[runtime status]', err?.message || err);
  }
}

async function probeVolume() {
  const now = new Date().toISOString();
  let previous = null;
  try {
    previous = JSON.parse(await readFile(VOLUME_PROBE_PATH, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('[volume probe] read failed', err?.message || err);
  }

  const boots = Number(previous?.boots || 0) + 1;
  const record = {
    firstSeen: previous?.firstSeen || now,
    lastSeen: now,
    boots,
    service: 'scanner-monitor',
  };
  await writeFile(VOLUME_PROBE_PATH, JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log('[volume probe]', JSON.stringify({
    path: VOLUME_PROBE_PATH,
    existed: Boolean(previous),
    previousBoots: Number(previous?.boots || 0),
    boots,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
  }));
}

async function main() {
  await probeVolume();
  const dbStatus = initializeDatabase();
  console.log('[sqlite boot]', JSON.stringify(dbStatus));

  initializeDeadLetterStore();
  console.log('[dead letter boot]', JSON.stringify(getDeadLetterStats()));

  ensurePriceMilestoneSchema();
  console.log('[price milestones boot]', JSON.stringify(getPriceMilestoneHealth()));

  ensureAthSchema();
  console.log('[ath boot]', JSON.stringify(getAthHealth()));

  ensureOpsSchema();
  recordOpsEvent({ level:'INFO', component:'runner', event:'boot', message:`scanner-monitor ${VERSION}`, details:dbStatus });

  persistenceProxy = await startPersistenceProxy({
    port: PERSIST_PROXY_PORT,
    upstreamUrl: UPSTREAM_SHEET_WEBHOOK_URL,
    localSecret: LOCAL_PERSIST_SECRET,
    upstreamSecret: UPSTREAM_SHEET_SECRET,
  });

  await Promise.all([rm(QUEUE_PATH, { force: true }), rm(OFFSET_PATH, { force: true })]);
  console.log('[runner] starting scanner + workers', JSON.stringify({
    version: VERSION,
    sqliteFirst: true,
    sqliteJobs: true,
    persistentCursor: true,
    deadLetters: true,
    priceMilestones: true,
    athTracking: true,
    opsEvents: true,
    runtimeHealth: true,
    legacyEnricher: LEGACY_ENRICHER,
    persistenceProxy: `http://127.0.0.1:${PERSIST_PROXY_PORT}/ingest`,
    rawSheetUpstreamConfigured: Boolean(UPSTREAM_SHEET_WEBHOOK_URL),
    resultSheetSyncConfigured: Boolean(RESULT_SHEET_WEBHOOK_URL && UPSTREAM_SHEET_SECRET),
  }));

  startEnricher();
  startJobWorker();
  startMarketTracker();
  startSheetSync();
  await refreshRuntimeStatus();
  runtimeTimer = setInterval(refreshRuntimeStatus, 15000);
  runtimeTimer.unref();

  const scanner = spawnNode('rh_newcoin_scanner.mjs', 'scanner', {
    SHEET_WEBHOOK_URL: `http://127.0.0.1:${PERSIST_PROXY_PORT}/ingest`,
    SHEET_INGEST_SECRET: LOCAL_PERSIST_SECRET,
  });

  scanner.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[runner scanner] stopped code=${code ?? ''} signal=${signal || ''}`);
      return;
    }
    console.error(`[runner scanner] exited unexpectedly code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'scanner', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    stopping = true;
    if (runtimeTimer) clearInterval(runtimeTimer);
    if (enricher && !enricher.killed) enricher.kill('SIGTERM');
    if (jobWorker && !jobWorker.killed) jobWorker.kill('SIGTERM');
    if (marketTracker && !marketTracker.killed) marketTracker.kill('SIGTERM');
    if (sheetSync && !sheetSync.killed) sheetSync.kill('SIGTERM');
    if (persistenceProxy) persistenceProxy.close();
    closeDatabase();
    process.exitCode = code && code > 0 ? code : 1;
  });

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] ${signal}; shutting down children`);
    try { recordOpsEvent({ level:'INFO', component:'runner', event:'shutdown', message:signal }); } catch {}
    if (runtimeTimer) clearInterval(runtimeTimer);
    if (scanner && !scanner.killed) scanner.kill(signal);
    if (enricher && !enricher.killed) enricher.kill(signal);
    if (jobWorker && !jobWorker.killed) jobWorker.kill(signal);
    if (marketTracker && !marketTracker.killed) marketTracker.kill(signal);
    if (sheetSync && !sheetSync.killed) sheetSync.kill(signal);
    if (persistenceProxy) persistenceProxy.close();
    closeDatabase();
    setTimeout(() => process.exit(0), 1500).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[runner fatal]', err);
  try { recordOpsEvent({ level:'ERROR', component:'runner', event:'fatal', message:String(err?.message || err) }); } catch {}
  try { closeDatabase(); } catch {}
  process.exitCode = 1;
});
