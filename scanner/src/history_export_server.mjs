import http from 'node:http';
import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';
import { ensureSignalOutcomeSchema, getOutcomeRows } from './signal_outcomes.mjs';
import { getHistoryCalibrationRows } from './history_calibration.mjs';
import { getThresholdOptimizationRows } from './threshold_optimizer.mjs';
import { ensureShadowThresholdSchema, getShadowThresholdRows } from './shadow_threshold_pool.mjs';
import { rowsToCsv } from './sheet_data.mjs';

const PORT = Math.max(1024, Number(process.env.HISTORY_EXPORT_PORT || 3105));
let server = null;
let stopping = false;

function outcomeRows() {
  const header = [
    'TriggeredAt','Symbol','CA','EventType','Score','Confidence','RiskGate',
    'EntryPrice','EntryMarketCap','EntryLiquidity',
    '15mReturnPct','1hReturnPct','6hReturnPct','24hReturnPct',
    'MaxRunupPct','MaxAdversePct','MaxDrawdownPct','MaxMultiple',
    'Hit30Clean','Hit50','Hit100','HitMinus30','OutcomeLabel','Status','DataQuality','LastSampleAt'
  ];
  const rows = getOutcomeRows(5000).filter(r => r.event_type === 'EARLY_ALPHA').slice(0, 1000).map(r => [
    r.triggered_at, r.symbol, r.token_address, r.event_type, r.score, r.confidence, r.risk_gate,
    r.entry_price_usd, r.entry_market_cap, r.entry_liquidity,
    r.m15_return_pct, r.h1_return_pct, r.h6_return_pct, r.h24_return_pct,
    r.max_runup_pct, r.max_adverse_pct, r.max_drawdown_pct, r.max_multiple,
    r.clean_win_30, r.hit_50, r.hit_100, r.hit_minus30,
    r.outcome_label, r.status, r.data_quality, r.last_sample_at,
  ]);
  return [header, ...rows];
}

function calibrationRows() {
  const header = [
    'Dimension','Bucket','Samples','CleanWin30Rate','Hit50Rate','Hit100Rate','Fail30Rate',
    'Median15m','Median1h','Median6h','Median24h','MedianMFE','MedianMAE','MedianMDD'
  ];
  const rows = getHistoryCalibrationRows().map(r => [
    r.dimension, r.bucket, r.samples, r.cleanWin30Rate, r.hit50Rate, r.hit100Rate, r.fail30Rate,
    r.median15m, r.median1h, r.median6h, r.median24h, r.medianMfe, r.medianMae, r.medianMdd,
  ]);
  return [header, ...rows];
}

function thresholdRows() {
  const header = [
    'RowType','Status','TotalSamples','CurrentScore','CurrentConfidence','CurrentLP',
    'RecommendedScore','RecommendedConfidence','RecommendedLP','CandidateSamples',
    'BaselineUtility','CandidateUtility','DeltaUtility','CleanWin30Rate','Hit50Rate','Hit100Rate',
    'Fail30Rate','Median24h','MedianMFE','MedianMDD','CoveragePct','Reason'
  ];
  const rows = getThresholdOptimizationRows(12).map(r => [
    r.rowType, r.status, r.samples, r.score, r.confidence, r.liquidity,
    r.recommendedScore, r.recommendedConfidence, r.recommendedLiquidity, r.candidateSamples,
    r.utility, r.recommendedUtility, r.deltaUtility, r.cleanWin30Rate, r.hit50Rate, r.hit100Rate,
    r.fail30Rate, r.median24h, r.medianMfe, r.medianMdd, r.coverage, r.reason,
  ]);
  return [header, ...rows];
}

function shadowRows() {
  const header = [
    'RowType','Profile','Status','Symbol','CA','Score','Confidence','LP','RiskGate','EnteredAt',
    'CompletedSamples','CleanWin30Rate','Fail30Rate','15mReturnPct','1hReturnPct','6hReturnPct','24hReturnPct',
    'MFE','MDD','OutcomeStatus','OutcomeLabel','Reason'
  ];
  const rows = getShadowThresholdRows().map(r => [
    r.rowType, r.profile, r.status, r.symbol, r.tokenAddress, r.score, r.confidence, r.liquidity, r.riskGate, r.enteredAt,
    r.completedSamples, r.cleanWin30Rate, r.fail30Rate, r.m15, r.h1, r.h6, r.h24,
    r.medianMfe, r.medianMdd, r.outcomeStatus, r.outcomeLabel, r.reason,
  ]);
  return [header, ...rows];
}

function secondLegRows() {
  const header = [
    'Symbol','CA','Stage','Score','Confidence','Drawdown','LP','VolumeH1','AmountRatio',
    'Buys','Sells','TxnRatio','Heat','RiskGate','ObservedAt','Price','ATHPrice','Reason'
  ];
  const db = getDatabase();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='second_leg_live'").get();
  if (!exists) return [header];
  const rows = db.prepare(`
    SELECT symbol, token_address, stage, score, confidence, drawdown, liquidity, volume_h1,
           amount_ratio, buys, sells, txn_ratio, heat_score, risk_gate, observed_at,
           price, ath_price, reason
    FROM second_leg_live
    ORDER BY CASE stage
      WHEN '二段启动' THEN 0
      WHEN '观察' THEN 1
      WHEN '待建历史' THEN 2
      WHEN '主池迁移锁' THEN 8
      WHEN '风险排除' THEN 9
      ELSE 5 END,
      score DESC, confidence DESC, liquidity DESC
    LIMIT 200
  `).all();
  return [header, ...rows.map(r => [
    r.symbol, r.token_address, r.stage, r.score, r.confidence, r.drawdown, r.liquidity, r.volume_h1,
    r.amount_ratio, r.buys, r.sells, r.txn_ratio, r.heat_score, r.risk_gate, r.observed_at,
    r.price, r.ath_price, r.reason,
  ])];
}

function sendCsv(res, rows) {
  const csv = rowsToCsv(rows);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-rh-history-version': '4',
  });
  res.end(csv);
}

async function main() {
  initializeDatabase();
  ensureSignalOutcomeSchema();
  ensureShadowThresholdSchema();
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, service: 'history-export', port: PORT, thresholdOptimizer: true, shadowPool: true, secondLegExport: true }));
        return;
      }
      if (url.pathname === '/history.csv') return sendCsv(res, outcomeRows());
      if (url.pathname === '/calibration.csv') return sendCsv(res, calibrationRows());
      if (url.pathname === '/thresholds.csv') return sendCsv(res, thresholdRows());
      if (url.pathname === '/shadow.csv') return sendCsv(res, shadowRows());
      if (url.pathname === '/second-leg.csv') return sendCsv(res, secondLegRows());
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not_found\n');
    } catch (err) {
      console.error('[history export]', String(err?.message || err));
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('export_error\n');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  console.log('[history export boot]', JSON.stringify({ address: `http://127.0.0.1:${PORT}`, thresholdOptimizer: true, shadowPool: true, secondLegExport: true }));
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (!server) {
    closeDatabase();
    return;
  }
  server.close(() => closeDatabase());
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(err => {
  console.error('[history export fatal]', err);
  try { closeDatabase(); } catch {}
  process.exitCode = 1;
});
