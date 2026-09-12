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
let compareReport = null;
let compareTimer = null;
let secondLegStartTimer = null;

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
function startStorageMaintenance() {
  if (stopping) return;
  storageMaintenance = start('./storage_maintenance.mjs', 'storage-maintenance');
  storageMaintenance.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[shadow-supervisor storage-maintenance] exited code=${code ?? ''} signal=${signal || ''}; restarting`);
    setTimeout(startStorageMaintenance, 10000).unref();
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
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (compareTimer) clearInterval(compareTimer);
  if (secondLegStartTimer) clearTimeout(secondLegStartTimer);
  for (const child of [compareReport, storageMaintenance, historyExport, historyWorker, shadowThresholdWorker, secondLegWorker, secondLegCandidateWorker, alertWorker, opportunityWorker, shadow, runner]) kill(child, signal);
}

runner = start('./runner.mjs', 'runner');
startShadow();
startOpportunityWorker();
startAlertWorker();
startSecondLegCandidateWorker();
secondLegStartTimer = setTimeout(startSecondLegWorker, 4000);
secondLegStartTimer.unref();
startShadowThresholdWorker();
startHistoryWorker();
startHistoryExport();
startStorageMaintenance();
setTimeout(startCompareReport, 15000).unref();
compareTimer = setInterval(startCompareReport, 300000);
compareTimer.unref();

runner.on('exit', (code, signal) => {
  if (!stopping) {
    stopping = true;
    if (compareTimer) clearInterval(compareTimer);
    if (secondLegStartTimer) clearTimeout(secondLegStartTimer);
    for (const child of [compareReport, storageMaintenance, historyExport, historyWorker, shadowThresholdWorker, secondLegWorker, secondLegCandidateWorker, alertWorker, opportunityWorker, shadow]) kill(child, 'SIGTERM');
  }
  console.error(`[shadow-supervisor runner] exited code=${code ?? ''} signal=${signal || ''}`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
