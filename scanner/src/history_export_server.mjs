import http from 'node:http';
import { initializeDatabase, closeDatabase } from './db.mjs';
import { ensureSignalOutcomeSchema, getOutcomeRows } from './signal_outcomes.mjs';
import { getHistoryCalibrationRows } from './history_calibration.mjs';
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
  const rows = getOutcomeRows(1000).map(r => [
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

function sendCsv(res, rows) {
  const csv = rowsToCsv(rows);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-rh-history-version': '1',
  });
  res.end(csv);
}

async function main() {
  initializeDatabase();
  ensureSignalOutcomeSchema();
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, service: 'history-export', port: PORT }));
        return;
      }
      if (url.pathname === '/history.csv') return sendCsv(res, outcomeRows());
      if (url.pathname === '/calibration.csv') return sendCsv(res, calibrationRows());
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
  console.log('[history export boot]', JSON.stringify({ address: `http://127.0.0.1:${PORT}` }));
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
