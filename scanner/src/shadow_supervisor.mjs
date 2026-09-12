import { spawn } from 'node:child_process';

let stopping = false;
let runner = null;
let shadow = null;
let opportunityWorker = null;
let alertWorker = null;
let secondLegCandidateWorker = null;
let secondLegWorker = null;
let shadowThresholdWorker = null;
let historyWorker = null;
let historyExport = null;
let storageMaintenance = null;
let poolDivergenceWorker = null;
let compareReport = null;
let compareTimer = null;
const startupTimers = [];

function start(file, label, extraEnv = {}) {
  const child = spawn(process.execPath, [new URL(file, import.meta.url).pathname], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  child.on('error', err => console.error(`[shadow-supervisor ${label}]`, err));
  return child;
}

function restartable(refSetter, file, label, extraEnv = {}) {
  if (stopping) return null;
  const child = start(file, label, extraEnv);
  refSetter(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[shadow-supervisor ${label}] exited code=${code ?? ''} signal=${signal || ''}; restarting`);
    setTimeout(() => restartable(refSetter, file, label, extraEnv), 5000).unref();
  });
  return child;
}

function schedule(fn, delayMs, label) {
  const timer = setTimeout(() => {
    if (stopping) return;
    console.log(`[shadow-supervisor startup] ${label} after ${delayMs}ms`);
    fn();
  }, delayMs);
  timer.unref();
  startupTimers.push(timer);
  return timer;
}

function startShadow() { return restartable(x => { shadow = x; }, './fast_m30_shadow.mjs', 'fast-m30', { RH_HTTP_URL: process.env.FAST_M30_RPC_URL || process.env.RH_HTTP_URL }); }
function startOpportunityWorker() { return restartable(x => { opportunityWorker = x; }, './opportunity_worker.mjs', 'opportunity-worker'); }
function startAlertWorker() { return restartable(x => { alertWorker = x; }, './alert_worker.mjs', 'alert-worker'); }
function startSecondLegCandidateWorker() { return restartable(x => { secondLegCandidateWorker = x; }, './second_leg_candidate_worker.mjs', 'second-leg-candidate-worker'); }
function startSecondLegWorker() {
  const generated = process.env.SECOND_LEG_GENERATED_WATCHLIST || '/data/second_leg_watchlist.generated.json';
  return restartable(x => { secondLegWorker = x; }, './second_leg_alert_worker.mjs', 'second-leg-alert-worker', { SECOND_LEG_WATCHLIST: generated });
}
function startShadowThresholdWorker() { return restartable(x => { shadowThresholdWorker = x; }, './shadow_threshold_worker.mjs', 'shadow-threshold-worker'); }
function startHistoryWorker() { return restartable(x => { historyWorker = x; }, './history_worker.mjs', 'history-worker'); }
function startHistoryExport() { return restartable(x => { historyExport = x; }, './history_export_server.mjs', 'history-export'); }
function startPoolDivergenceWorker() { return restartable(x => { poolDivergenceWorker = x; }, './pool_divergence_worker.mjs', 'pool-divergence-worker'); }
function startStorageMaintenance() {
  if (stopping) return;
  // The package boot probe intentionally runs storage maintenance once before the
  // supervisor starts. Some production launchers can leave that ONCE flag in the
  // inherited environment, so force the supervised process into long-running mode.
  storageMaintenance = start('./storage_maintenance.mjs', 'storage-maintenance', { STORAGE_MAINTENANCE_ONCE: 'false' });
  storageMaintenance.on('exit', (code, signal) => {
    if (stopping) return;
    const delayMs = code === 0 ? 60_000 : 10_000;
    console.error(`[shadow-supervisor storage-maintenance] exited code=${code ?? ''} signal=${signal || ''}; restarting in ${delayMs}ms`);
    setTimeout(startStorageMaintenance, delayMs).unref();
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
function kill(child, signal) { if (child && !child.killed) child.kill(signal); }
function clearStartupTimers() { for (const timer of startupTimers) clearTimeout(timer); }
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (compareTimer) clearInterval(compareTimer);
  clearStartupTimers();
  for (const child of [compareReport, poolDivergenceWorker, storageMaintenance, historyExport, historyWorker, shadowThresholdWorker, secondLegWorker, secondLegCandidateWorker, alertWorker, opportunityWorker, shadow, runner]) kill(child, signal);
}

// The runner owns the core scanner and performs the heaviest SQLite schema boot work.
// Start it alone, then stagger auxiliary writers so they do not all execute SQLite
// PRAGMA/schema initialization in the same millisecond after a systemd restart.
runner = start('./runner.mjs', 'runner');
schedule(startShadow, 3000, 'fast-m30');
schedule(startOpportunityWorker, 5000, 'opportunity-worker');
schedule(startAlertWorker, 7000, 'alert-worker');
schedule(startShadowThresholdWorker, 9000, 'shadow-threshold-worker');
schedule(startHistoryWorker, 11000, 'history-worker');
schedule(startHistoryExport, 13000, 'history-export');
schedule(startStorageMaintenance, 15000, 'storage-maintenance');
schedule(startSecondLegCandidateWorker, 17000, 'second-leg-candidate-worker');
schedule(startSecondLegWorker, 21000, 'second-leg-alert-worker');
schedule(startCompareReport, 25000, 'fast-compare');
schedule(startPoolDivergenceWorker, 29000, 'pool-divergence-worker');
compareTimer = setInterval(startCompareReport, 300000);
compareTimer.unref();

runner.on('exit', (code, signal) => {
  if (!stopping) {
    stopping = true;
    if (compareTimer) clearInterval(compareTimer);
    clearStartupTimers();
    for (const child of [compareReport, poolDivergenceWorker, storageMaintenance, historyExport, historyWorker, shadowThresholdWorker, secondLegWorker, secondLegCandidateWorker, alertWorker, opportunityWorker, shadow]) kill(child, 'SIGTERM');
  }
  console.error(`[shadow-supervisor runner] exited code=${code ?? ''} signal=${signal || ''}`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
