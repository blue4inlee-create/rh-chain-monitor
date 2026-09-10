import { initializeDatabase, closeDatabase } from './db.mjs';
import { ensurePriceMilestoneSchema } from './price_milestones.mjs';
import { ensureAthSchema } from './ath_metrics.mjs';
import { buildFastM30CompareRows } from './fast_m30_compare.mjs';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function median(values) {
  const a = values.map(n).filter(v => v != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function rate(rows, col, value = 'Y') {
  if (!rows.length) return null;
  return rows.filter(r => r[col] === value).length / rows.length;
}

function round(v, digits = 4) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const p = 10 ** digits;
  return Math.round(Number(v) * p) / p;
}

try {
  initializeDatabase();
  ensurePriceMilestoneSchema();
  ensureAthSchema();
  const table = buildFastM30CompareRows();
  const rows = table.slice(1);
  const fastMature = rows.filter(r => n(r[11]) >= 30);
  const paired = rows.filter(r => r[7]);
  const pairedBothMature = paired.filter(r => n(r[11]) >= 30 && n(r[17]) >= 30);

  const summary = {
    generatedAt: new Date().toISOString(),
    qualifyTotal: rows.length,
    fastMature30m: fastMature.length,
    pairedTotal: paired.length,
    pairedBothMature30m: pairedBothMature.length,
    pairMedianLeadSec: round(median(paired.map(r => r[9])), 2),
    pairMedianCanaryMcOverFastMc: round(median(paired.map(r => r[10])), 4),
    matureFastAll: {
      n: fastMature.length,
      hit12: fastMature.filter(r => r[14] === 'Y').length,
      hit12Rate: round(rate(fastMature, 14), 4),
      hit2: fastMature.filter(r => r[15] === 'Y').length,
      hit2Rate: round(rate(fastMature, 15), 4),
      falsePositive: fastMature.filter(r => r[16] === 'Y').length,
      falsePositiveRate: round(rate(fastMature, 16), 4),
    },
    samePairMature: {
      n: pairedBothMature.length,
      fastHit12: pairedBothMature.filter(r => r[14] === 'Y').length,
      fastHit12Rate: round(rate(pairedBothMature, 14), 4),
      canaryHit12: pairedBothMature.filter(r => r[20] === 'Y').length,
      canaryHit12Rate: round(rate(pairedBothMature, 20), 4),
      fastHit2: pairedBothMature.filter(r => r[15] === 'Y').length,
      fastHit2Rate: round(rate(pairedBothMature, 15), 4),
      canaryHit2: pairedBothMature.filter(r => r[21] === 'Y').length,
      canaryHit2Rate: round(rate(pairedBothMature, 21), 4),
      fastFalsePositive: pairedBothMature.filter(r => r[16] === 'Y').length,
      fastFalsePositiveRate: round(rate(pairedBothMature, 16), 4),
      canaryFalsePositive: pairedBothMature.filter(r => r[22] === 'Y').length,
      canaryFalsePositiveRate: round(rate(pairedBothMature, 22), 4),
    },
  };

  const details = paired.map(r => ({
    symbol: r[0], token: r[1], fastAt: r[3], fastAgeSec: r[4], fastScore: r[5], fastMc: r[6],
    canaryAt: r[7], canaryMc: r[8], leadSec: r[9], canaryMcOverFastMc: r[10],
    fastObsMin: r[11], fastCurrent: r[12], fastMax: r[13],
    canaryObsMin: r[17], canaryCurrent: r[18], canaryMax: r[19],
    fastFalse: r[16], canaryFalse: r[22],
  }));

  console.log('[fast-compare summary]', JSON.stringify(summary));
  console.log('[fast-compare pairs]', JSON.stringify(details));
} catch (err) {
  console.error('[fast-compare error]', err?.stack || err?.message || err);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
