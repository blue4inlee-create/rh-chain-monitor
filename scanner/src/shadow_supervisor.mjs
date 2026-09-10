import { spawn } from 'node:child_process';

let stopping = false;
let runner = null;
let shadow = null;
let compareReport = null;
let compareTimer = null;

function start(file, label, extraEnv = {}) {
  const child = spawn(process.execPath, [new URL(file, import.meta.url).pathname], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  child.on('error', err => console.error(`[shadow-supervisor ${label}]`, err));
  return child;
}

function startShadow() {
  if (stopping) return;
  shadow = start('./fast_m30_shadow.mjs', 'fast-m30', {
    RH_HTTP_URL: process.env.FAST_M30_RPC_URL || process.env.RH_HTTP_URL,
  });
  shadow.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[shadow-supervisor fast-m30] exited code=${code ?? ''} signal=${signal || ''}; restarting`);
    setTimeout(startShadow, 5000).unref();
  });
}

function startCompareReport() {
  if (stopping || (compareReport && compareReport.exitCode == null && !compareReport.killed)) return;
  compareReport = start('./fast_m30_compare_report.mjs', 'fast-compare');
  compareReport.on('exit', (code, signal) => {
    console.log(`[shadow-supervisor fast-compare] stopped code=${code ?? ''} signal=${signal || ''}`);
    compareReport = null;
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (compareTimer) clearInterval(compareTimer);
  if (compareReport && !compareReport.killed) compareReport.kill(signal);
  if (shadow && !shadow.killed) shadow.kill(signal);
  if (runner && !runner.killed) runner.kill(signal);
}

runner = start('./runner.mjs', 'runner');
startShadow();
setTimeout(startCompareReport, 15000).unref();
compareTimer = setInterval(startCompareReport, 300000);
compareTimer.unref();

runner.on('exit', (code, signal) => {
  if (!stopping) {
    stopping = true;
    if (compareTimer) clearInterval(compareTimer);
    if (compareReport && !compareReport.killed) compareReport.kill('SIGTERM');
    if (shadow && !shadow.killed) shadow.kill('SIGTERM');
  }
  console.error(`[shadow-supervisor runner] exited code=${code ?? ''} signal=${signal || ''}`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
