import { spawn } from 'node:child_process';

const ROOT = new URL('.', import.meta.url);
let stopping = false;
let enricher = null;

function spawnNode(file, label) {
  const child = spawn(process.execPath, [new URL(file, ROOT).pathname], {
    stdio: 'inherit',
    env: process.env,
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

console.log('[runner] starting scanner + isolated enricher');
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
