import { spawn } from 'node:child_process';

let stopping = false;
let runner = null;
let shadow = null;

function start(file, label) {
  const child = spawn(process.execPath, [new URL(file, import.meta.url).pathname], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('error', err => console.error(`[shadow-supervisor ${label}]`, err));
  return child;
}

function startShadow() {
  if (stopping) return;
  shadow = start('./fast_m30_shadow.mjs', 'fast-m30');
  shadow.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[shadow-supervisor fast-m30] exited code=${code ?? ''} signal=${signal || ''}; restarting`);
    setTimeout(startShadow, 5000).unref();
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (shadow && !shadow.killed) shadow.kill(signal);
  if (runner && !runner.killed) runner.kill(signal);
}

runner = start('./runner.mjs', 'runner');
startShadow();

runner.on('exit', (code, signal) => {
  if (!stopping) {
    stopping = true;
    if (shadow && !shadow.killed) shadow.kill('SIGTERM');
  }
  console.error(`[shadow-supervisor runner] exited code=${code ?? ''} signal=${signal || ''}`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
