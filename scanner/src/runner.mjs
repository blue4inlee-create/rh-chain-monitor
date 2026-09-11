import http from 'node:http';
import { spawn } from 'node:child_process';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { initializeDatabase, closeDatabase } from './db.mjs';
import { initializeDeadLetterStore, getDeadLetterStats } from './dead_letter.mjs';
import { ensurePriceMilestoneSchema, getPriceMilestoneHealth } from './price_milestones.mjs';
import { ensureAthSchema, getAthHealth } from './ath_metrics.mjs';
import { ensureStageSchema } from './stages.mjs';
import { ensureRiskSchema } from './risk.mjs';
import { ensureScoreSchema } from './scoring.mjs';
import { startPersistenceProxy } from './persistence_proxy.mjs';
import { ensureOpsSchema, recordOpsEvent, writeRuntimeStatus, STATUS_PATH } from './ops_status.mjs';
import { buildSheetPayload, rowsToCsv } from './sheet_data.mjs';
import { getOpportunityExportRows } from './opportunity_export.mjs';

const VERSION = '2.14.1';
const ROOT = new URL('.', import.meta.url);
const QUEUE_PATH = process.env.ENRICH_QUEUE_PATH || '/tmp/rh_enrich_queue.jsonl';
const OFFSET_PATH = process.env.ENRICH_OFFSET_PATH || '/tmp/rh_enrich_queue.offset';
const VOLUME_PROBE_PATH = process.env.VOLUME_PROBE_PATH || '/data/volume_probe.json';
const HEALTH_PORT = Number(process.env.PORT || 8080);
const SCANNER_INTERNAL_PORT = Number(process.env.SCANNER_INTERNAL_PORT || 3102);
const PERSIST_PROXY_PORT = Number(process.env.PERSIST_PROXY_PORT || 3101);
const UPSTREAM_SHEET_WEBHOOK_URL = String(process.env.SHEET_WEBHOOK_URL || '').trim();
const RESULT_SHEET_WEBHOOK_URL = String(process.env.RESULT_SHEET_WEBHOOK_URL || '').trim();
const UPSTREAM_SHEET_SECRET = String(process.env.SHEET_INGEST_SECRET || '').trim();
const RESULT_EXPORT_TOKEN = String(process.env.RESULT_EXPORT_TOKEN || '').trim();
const LOCAL_PERSIST_SECRET = 'sqlite-local-ingest';
const LEGACY_ENRICHER = /^(1|true|yes)$/i.test(String(process.env.LEGACY_ENRICHER_ENABLED || 'false'));
let stopping = false;
let scanner = null;
let enricher = null;
let jobWorker = null;
let marketTracker = null;
let sheetSync = null;
let persistenceProxy = null;
let healthServer = null;
let runtimeTimer = null;
let exportCache = { at: 0, payload: null };

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
    if (stopping) return console.log(`[runner enricher] stopped code=${code ?? ''} signal=${signal || ''}`);
    console.error(`[runner enricher] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'enricher', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startEnricher, 5000).unref();
  });
}

function startJobWorker() {
  if (stopping) return;
  jobWorker = spawnNode('job_worker.mjs', 'job-worker');
  jobWorker.on('exit', (code, signal) => {
    if (stopping) return console.log(`[runner job-worker] stopped code=${code ?? ''} signal=${signal || ''}`);
    console.error(`[runner job-worker] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'job-worker', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startJobWorker, 5000).unref();
  });
}

function startMarketTracker() {
  if (stopping) return;
  marketTracker = spawnNode('canary_market_tracker.mjs', 'canary-market-tracker');
  marketTracker.on('exit', (code, signal) => {
    if (stopping) return console.log(`[runner canary-market-tracker] stopped code=${code ?? ''} signal=${signal || ''}`);
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
    if (stopping) return console.log(`[runner sheet-sync] stopped code=${code ?? ''} signal=${signal || ''}`);
    console.error(`[runner sheet-sync] exited code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'sheet-sync', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    setTimeout(startSheetSync, 5000).unref();
  });
}

function alive(child) {
  return Boolean(child && child.exitCode == null && !child.killed);
}

function workerStatus() {
  return {
    scanner: alive(scanner),
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
        mode: RESULT_EXPORT_TOKEN ? 'pull-csv' : (RESULT_SHEET_WEBHOOK_URL ? 'webhook' : 'disabled'),
        pullConfigured: Boolean(RESULT_EXPORT_TOKEN),
        webhookConfigured: Boolean(RESULT_SHEET_WEBHOOK_URL && UPSTREAM_SHEET_SECRET),
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

async function scannerCoreHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${SCANNER_INTERNAL_PORT}/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return { ok:false, status:res.status };
    return await res.json();
  } catch (err) {
    return { ok:false, error:String(err?.message || err) };
  }
}

async function compositeHealth() {
  let runtime = null;
  try { runtime = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}
  const core = await scannerCoreHealth();
  const ageMs = runtime?.generatedAt ? Date.now() - new Date(runtime.generatedAt).getTime() : Infinity;
  const workers = runtime?.workers || workerStatus();
  const healthy = Boolean(core?.ok && ageMs < 60000 && workers.scanner && workers.jobWorker && workers.canaryMarketTracker);
  return {
    ok: healthy,
    service: 'scanner-monitor',
    version: VERSION,
    checkedAt: new Date().toISOString(),
    runtimeAgeSec: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    scannerCore: core,
    ...runtime,
    ok: healthy,
  };
}

function cachedSheetPayload() {
  if (exportCache.payload && Date.now() - exportCache.at < 30_000) return exportCache.payload;
  const payload = buildSheetPayload();
  exportCache = { at: Date.now(), payload };
  return payload;
}

function opportunityExportRows() {
  const header = ['Symbol','CA','Stage','Score','Classification','Confidence','ScoreVersion','Heat','LiquidityScore','Flow','HolderScore','ProjectScore','RiskPenalty','MarketCap','Liquidity','Volume24h','Holders','Buys','Sells','HolderGrowth','NarrativeType','RiskFlags','Tags','UpdatedAt'];
  const rows = getOpportunityExportRows(500).map(r => [
    r.symbol, r.address, r.stage, r.score, r.classification, r.scoreConfidence, r.scoreVersion,
    r.heatScore, r.liquidityScore, r.flowScore, r.holderScore, r.projectScore, r.riskPenalty,
    r.marketCap, r.liquidity, r.volume24h, r.holders, r.buys, r.sells, r.holderGrowth,
    r.narrativeType, (r.riskFlags || []).join('|'), (r.tags || []).join('|'), r.updatedAt
  ]);
  return [header, ...rows];
}

function exportRows(pathname) {
  const payload = cachedSheetPayload();
  if (pathname === '/export/discovery.csv') return payload.sheets['新币发现'];
  if (pathname === '/export/canary.csv') return payload.sheets['Canary跟踪'];
  if (pathname === '/export/stages.csv') return payload.sheets['阶段升级记录'];
  if (pathname === '/export/lifecycle.csv') return payload.sheets['生命周期'];
  if (pathname === '/export/opportunity.csv') return opportunityExportRows();
  return null;
}

function startHealthServer() {
  healthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') {
      const body = await compositeHealth();
      res.writeHead(body.ok ? 200 : 503, { 'content-type':'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify(body));
      return;
    }

    if (url.pathname.startsWith('/export/')) {
      if (!RESULT_EXPORT_TOKEN || url.searchParams.get('token') !== RESULT_EXPORT_TOKEN) {
        res.writeHead(401, { 'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store' });
        res.end('unauthorized\n');
        return;
      }
      try {
        const rows = exportRows(url.pathname);
        if (!rows) {
          res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' });
          res.end('not_found\n');
          return;
        }
        const csv = rowsToCsv(rows);
        res.writeHead(200, {
          'content-type':'text/csv; charset=utf-8',
          'cache-control':'no-store, max-age=0',
          'x-rh-result-version': VERSION,
        });
        res.end(csv);
        console.log('[result export]', JSON.stringify({ path:url.pathname, rows:rows.length, bytes:Buffer.byteLength(csv) }));
        return;
      } catch (err) {
        console.error('[result export]', err?.message || err);
        res.writeHead(500, { 'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store' });
        res.end('export_error\n');
        return;
      }
    }

    res.writeHead(404, { 'content-type':'application/json' });
    res.end(JSON.stringify({ ok:false, error:'not_found' }));
  });
  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => console.log(`[runner health] listening on :${HEALTH_PORT}`));
}

async function probeVolume() {
  const now = new Date().toISOString();
  let previous = null;
  try { previous = JSON.parse(await readFile(VOLUME_PROBE_PATH, 'utf8')); }
  catch (err) { if (err?.code !== 'ENOENT') console.warn('[volume probe] read failed', err?.message || err); }

  const boots = Number(previous?.boots || 0) + 1;
  const record = { firstSeen: previous?.firstSeen || now, lastSeen: now, boots, service: 'scanner-monitor' };
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
  ensureRiskSchema();
  ensureScoreSchema();
  ensureStageSchema();
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
    resultPullCsv: Boolean(RESULT_EXPORT_TOKEN),
    legacyEnricher: LEGACY_ENRICHER,
    persistenceProxy: `http://127.0.0.1:${PERSIST_PROXY_PORT}/ingest`,
    rawSheetUpstreamConfigured: Boolean(UPSTREAM_SHEET_WEBHOOK_URL),
    resultSheetSyncConfigured: Boolean(RESULT_SHEET_WEBHOOK_URL && UPSTREAM_SHEET_SECRET),
  }));

  startHealthServer();
  startEnricher();
  startJobWorker();
  startMarketTracker();
  startSheetSync();

  scanner = spawnNode('rh_newcoin_scanner.mjs', 'scanner', {
    PORT: String(SCANNER_INTERNAL_PORT),
    SHEET_WEBHOOK_URL: `http://127.0.0.1:${PERSIST_PROXY_PORT}/ingest`,
    SHEET_INGEST_SECRET: LOCAL_PERSIST_SECRET,
  });

  await new Promise(resolve => setTimeout(resolve, 250));
  await refreshRuntimeStatus();
  runtimeTimer = setInterval(refreshRuntimeStatus, 15000);
  runtimeTimer.unref();

  scanner.on('exit', (code, signal) => {
    if (stopping) return console.log(`[runner scanner] stopped code=${code ?? ''} signal=${signal || ''}`);
    console.error(`[runner scanner] exited unexpectedly code=${code} signal=${signal || ''}`);
    try { recordOpsEvent({ level:'ERROR', component:'scanner', event:'unexpected_exit', details:{ code, signal } }); } catch {}
    stopping = true;
    if (runtimeTimer) clearInterval(runtimeTimer);
    if (enricher && !enricher.killed) enricher.kill('SIGTERM');
    if (jobWorker && !jobWorker.killed) jobWorker.kill('SIGTERM');
    if (marketTracker && !marketTracker.killed) marketTracker.kill('SIGTERM');
    if (sheetSync && !sheetSync.killed) sheetSync.kill('SIGTERM');
    if (persistenceProxy) persistenceProxy.close();
    if (healthServer) healthServer.close();
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
    if (healthServer) healthServer.close();
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
