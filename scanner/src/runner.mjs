import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

const ROOT = new URL('.', import.meta.url);
const QUEUE_PATH = process.env.ENRICH_QUEUE_PATH || '/tmp/rh_enrich_queue.jsonl';
const OFFSET_PATH = process.env.ENRICH_OFFSET_PATH || '/tmp/rh_enrich_queue.offset';
let stopping = false;
let enricher = null;

function spawnNode(file, label) {
  const child = spawn(process.execPath, [new URL(file, ROOT).pathname], {
    stdio: 'inherit',
    env: { ...process.env, ENRICH_QUEUE_PATH: QUEUE_PATH, ENRICH_OFFSET_PATH: OFFSET_PATH },
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

async function main() {
  await Promise.all([rm(QUEUE_PATH, { force: true }), rm(OFFSET_PATH, { force: true })]);
  console.log('[runner] starting scanner + queue enricher', JSON.stringify({ version: '2.2.0', queue: QUEUE_PATH }));
  startEnricher();
  const scanner = spawnNode('rh_newcoin_scanner.mjs', 'scanner');

  scanner.on('exit', (code, signal) => {
    console.error(`[runner scanner] exited code=${code} signal=${signal || ''}`);
    stopping = true;
    if (enricher && !enricher.killed) enricher.kill('SIGTERM');
    process.exitCode = code ?? 1;
  });

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] ${signal}; shutting down children`);
    if (scanner && !scanner.killed) scanner.kill(signal);
    if (enricher && !enricher.killed) enricher.kill(signal);
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[runner fatal]', err);
  process.exitCode = 1;
});
