import { getDatabase } from './db.mjs';
import { ensureSignalOutcomeSchema } from './signal_outcomes.mjs';

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function median(values) {
  const xs = values.map(num).filter(v => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
}
function scoreBucket(v) {
  const n = num(v) ?? 0;
  if (n >= 85) return '85+';
  if (n >= 80) return '80-84';
  if (n >= 75) return '75-79';
  return '70-74';
}
function confidenceBucket(v) {
  const n = num(v) ?? 0;
  if (n >= 80) return '80+';
  if (n >= 70) return '70-79';
  return '60-69';
}
function liquidityBucket(v) {
  const n = num(v) ?? 0;
  if (n >= 100000) return '100K+';
  if (n >= 50000) return '50-100K';
  if (n >= 20000) return '20-50K';
  return '10-20K';
}
function summarizeGroup(dimension, bucket, rows) {
  const n = rows.length;
  const rate = key => n ? rows.filter(r => Number(r[key] || 0) === 1).length / n * 100 : null;
  return {
    dimension,
    bucket,
    samples: n,
    cleanWin30Rate: rate('clean_win_30'),
    hit50Rate: rate('hit_50'),
    hit100Rate: rate('hit_100'),
    fail30Rate: rate('hit_minus30'),
    median15m: median(rows.map(r => r.m15_return_pct)),
    median1h: median(rows.map(r => r.h1_return_pct)),
    median6h: median(rows.map(r => r.h6_return_pct)),
    median24h: median(rows.map(r => r.h24_return_pct)),
    medianMfe: median(rows.map(r => r.max_runup_pct)),
    medianMae: median(rows.map(r => r.max_adverse_pct)),
    medianMdd: median(rows.map(r => r.max_drawdown_pct)),
  };
}

export function getHistoryCalibrationRows() {
  ensureSignalOutcomeSchema();
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM signal_outcomes
    WHERE event_type='EARLY_ALPHA' AND status='COMPLETE' AND data_quality<>'THIN'
  `).all();
  const groups = [];
  const dimensions = [
    ['Score', r => scoreBucket(r.score)],
    ['Confidence', r => confidenceBucket(r.confidence)],
    ['Liquidity', r => liquidityBucket(r.entry_liquidity)],
    ['RiskGate', r => text(r.risk_gate) || 'UNKNOWN'],
  ];
  for (const [dimension, fn] of dimensions) {
    const map = new Map();
    for (const r of rows) {
      const bucket = fn(r);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket).push(r);
    }
    for (const [bucket, items] of map) groups.push(summarizeGroup(dimension, bucket, items));
  }
  for (const cutoff of [70, 75, 80, 85]) {
    const items = rows.filter(r => Number(r.score || 0) >= cutoff);
    if (items.length) groups.push(summarizeGroup('ScoreCutoff', `>=${cutoff}`, items));
  }
  return groups;
}
