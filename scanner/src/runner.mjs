import { spawn } from 'node:child_process';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { initializeDatabase, closeDatabase } from './db.mjs';
import { startPersistenceProxy } from './persistence_proxy.mjs';

const ROOT = new URL('.', import.meta.url);
const QUEUE_PATH = process.env.ENRICH_QUEUE_PATH || '/tmp/rh_enrich_queue.jsonl';
const OFFSET_PATH = process.env.ENRICH_OFFSET_PATH || '/tmp/rh_enrich_queue.offset';
const VOLUME_PROBE_PATH = process.env.VOLUME_PROBE_PATH || '/data/volume_probe.json';
const PERSIST_PROXY_PORT = Number(process.env.PERSIST_PROXY_PORT || 3101);
const UPSTREAM_SHEET_WEBHOOK_URL = String(process.env.SHEET_WEBHOOK_URL || '').trim();
const UPSTREAM_SHEET_SECRET = String(process.env.SHEET_INGEST_SECRET || '').trim();
const LOCAL_PERSIST_SECRET = 'sqlite-local-ingest';
let stopping = false;
let enricher = null;
let persistenceProxy = null;

function spawnNode(file, label, extraEnv = {}) {
  const child = spawn(process.execPath, [new URL(file, ROOT).pathname], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ENRICH_QUEUE_PATH: QUEUE_PATH,
      ENRICH_OFFSET_PATH: OFFSET_PATH,
      ...extraEnv,
    },
  });
  child.on('error', (err) => console.error(`[runner ${label}] spawn error`, err));
  return child;
}

function startEnricher() {
  if (stopping) return;
  enricher = spawnNode('enricher.mjs', 'enricher');
  enricher.on('exit', (code, signal) => {
    console.error(`[runner enricher] exited code=${code} signal=${signal || ''}`);
    if (!stopping) setTimeout(startEnricher, 5000).unref();
  });
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

  persistenceProxy = await startPersistenceProxy({
    port: PERSIST_PROXY_PORT,
    upstreamUrl: UPSTREAM_SHEET_WEBHOOK_URL,
    localSecret: LOCAL_PERSIST_SECRET,
    upstreamSecret: UPSTREAM_SHEET_SECRET,
  });

  await Promise.all([rm(QUEUE_PATH, { force: true }), rm(OFFSET_PATH, { force: true })]);
  console.log('[runner] starting scanner + queue enricher', JSON.stringify({
    version: '2.4.1',
    queue: QUEUE_PATH,
    sqliteFirst: true,
    persistenceProxy: `http://127.0.0.1:${PERSIST_PROXY_PORT}/ingest`,
    upstreamSheetConfigured: Boolean(UPSTREAM_SHEET_WEBHOOK_URL),
  }));

  startEnricher();
  const scanner = spawnNode('rh_newcoin_scanner.mjs', 'scanner', {
    SHEET_WEBHOOK_URL: `http://127.0.0.1:${PERSIST_PROXY_PORT}/ingest`,
    SHEET_INGEST_SECRET: LOCAL_PERSIST_SECRET,
  });

  scanner.on('exit', (code, signal) => {
    console.error(`[runner scanner] exited code=${code} signal=${signal || ''}`);
    stopping = true;
    if (enricher && !enricher.killed) enricher.kill('SIGTERM');
    if (persistenceProxy) persistenceProxy.close();
    closeDatabase();
    process.exitCode = code ?? 1;
  });

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] ${signal}; shutting down children`);
    if (scanner && !scanner.killed) scanner.kill(signal);
    if (enricher && !enricher.killed) enricher.kill(signal);
    if (persistenceProxy) persistenceProxy.close();
    closeDatabase();
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[runner fatal]', err);
  try { closeDatabase(); } catch {}
  process.exitCode = 1;
});
