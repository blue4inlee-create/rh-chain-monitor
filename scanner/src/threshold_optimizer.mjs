import { getDatabase } from './db.mjs';
import { ensureSignalOutcomeSchema } from './signal_outcomes.mjs';

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v || 0))); }
function median(values) {
  const xs = values.map(num).filter(v => v != null).sort((a,b) => a-b);
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i-1] + xs[i]) / 2;
}
function rate(rows, key) {
  if (!rows.length) return null;
  return rows.filter(r => Number(r[key] || 0) === 1).length / rows.length * 100;
}

export function summarizeThresholdRows(rows = []) {
  const n = rows.length;
  const clean = rate(rows, 'clean_win_30') ?? 0;
  const hit50 = rate(rows, 'hit_50') ?? 0;
  const hit100 = rate(rows, 'hit_100') ?? 0;
  const fail30 = rate(rows, 'hit_minus30') ?? 0;
  const median24 = median(rows.map(r => r.h24_return_pct));
  const medianMfe = median(rows.map(r => r.max_runup_pct));
  const medianMdd = median(rows.map(r => r.max_drawdown_pct));
  const utility =
    clean * 0.34 +
    hit50 * 0.22 +
    hit100 * 0.12 -
    fail30 * 0.26 +
    clamp(median24 ?? 0, -100, 200) * 0.04 +
    clamp(medianMfe ?? 0, 0, 300) * 0.025 +
    clamp(medianMdd ?? 0, -100, 0) * 0.015;
  return { n, clean, hit50, hit100, fail30, median24, medianMfe, medianMdd, utility };
}

export function optimizeThresholds(rows = [], options = {}) {
  const baseline = {
    score: Number(options.score ?? process.env.ALERT_MIN_SCORE ?? 70),
    confidence: Number(options.confidence ?? process.env.ALERT_MIN_CONFIDENCE ?? 60),
    liquidity: Number(options.liquidity ?? process.env.ALERT_MIN_LIQUIDITY ?? 10000),
  };
  const minTotal = Math.max(20, Number(options.minTotal ?? process.env.THRESHOLD_MIN_TOTAL_SAMPLES ?? 30));
  const minCandidate = Math.max(8, Number(options.minCandidate ?? process.env.THRESHOLD_MIN_CANDIDATE_SAMPLES ?? 12));
  const minDelta = Number(options.minDelta ?? process.env.THRESHOLD_MIN_UTILITY_DELTA ?? 5);

  const valid = rows.filter(r =>
    String(r.event_type || 'EARLY_ALPHA') === 'EARLY_ALPHA' &&
    String(r.status || '') === 'COMPLETE' &&
    String(r.data_quality || '') !== 'THIN'
  );
  const baselineRows = valid.filter(r =>
    Number(r.score || 0) >= baseline.score &&
    Number(r.confidence || 0) >= baseline.confidence &&
    Number(r.entry_liquidity || 0) >= baseline.liquidity
  );
  const base = summarizeThresholdRows(baselineRows);

  const scores = [baseline.score, 75, 80, 85].filter((v,i,a) => v >= baseline.score && a.indexOf(v) === i).sort((a,b)=>a-b);
  const confidences = [baseline.confidence, 70, 75, 80].filter((v,i,a) => v >= baseline.confidence && a.indexOf(v) === i).sort((a,b)=>a-b);
  const liquidities = [baseline.liquidity, 20000, 50000, 100000].filter((v,i,a) => v >= baseline.liquidity && a.indexOf(v) === i).sort((a,b)=>a-b);

  const candidates = [];
  for (const score of scores) for (const confidence of confidences) for (const liquidity of liquidities) {
    const selected = valid.filter(r =>
      Number(r.score || 0) >= score &&
      Number(r.confidence || 0) >= confidence &&
      Number(r.entry_liquidity || 0) >= liquidity
    );
    const s = summarizeThresholdRows(selected);
    const coverage = valid.length ? s.n / valid.length * 100 : 0;
    const adjustedUtility = s.utility + Math.min(8, coverage * 0.08);
    candidates.push({ score, confidence, liquidity, coverage, adjustedUtility, ...s });
  }
  candidates.sort((a,b) => b.adjustedUtility - a.adjustedUtility || b.n - a.n);

  let recommendation = { score: baseline.score, confidence: baseline.confidence, liquidity: baseline.liquidity, ...base, coverage: valid.length ? base.n/valid.length*100 : 0, adjustedUtility: base.utility };
  let status = 'WARMUP';
  let reason = `等待至少 ${minTotal} 个完整样本；当前 ${valid.length} 个`;

  if (valid.length >= minTotal && base.n >= minCandidate) {
    status = 'HOLD_BASELINE';
    reason = '历史样本已达最低要求，但没有更优且足够稳健的阈值组合';
    const eligible = candidates.filter(c =>
      c.n >= minCandidate &&
      c.adjustedUtility >= (base.utility + minDelta) &&
      c.clean >= (base.clean - 2) &&
      c.fail30 <= (base.fail30 + 2)
    );
    if (eligible.length) {
      recommendation = eligible[0];
      status = 'READY_TO_APPLY';
      reason = `候选效用较当前基线提升 ${(recommendation.adjustedUtility - base.utility).toFixed(1)}，且样本数/胜率/失败率通过保护条件`;
    }
  }

  return { baseline, totalSamples: valid.length, minTotal, minCandidate, minDelta, base, recommendation, status, reason, candidates };
}

export function getThresholdOptimization() {
  ensureSignalOutcomeSchema();
  const rows = getDatabase().prepare(`SELECT * FROM signal_outcomes ORDER BY triggered_at DESC`).all();
  return optimizeThresholds(rows);
}

export function getThresholdOptimizationRows(limit = 12) {
  const result = getThresholdOptimization();
  const b = result.baseline;
  const r = result.recommendation;
  const rows = [{
    rowType: 'SUMMARY', status: result.status, samples: result.totalSamples,
    score: b.score, confidence: b.confidence, liquidity: b.liquidity,
    recommendedScore: r.score, recommendedConfidence: r.confidence, recommendedLiquidity: r.liquidity,
    candidateSamples: r.n ?? 0, utility: result.base.utility, recommendedUtility: r.adjustedUtility ?? r.utility,
    deltaUtility: (r.adjustedUtility ?? r.utility ?? 0) - (result.base.utility || 0),
    cleanWin30Rate: r.clean, hit50Rate: r.hit50, hit100Rate: r.hit100, fail30Rate: r.fail30,
    median24h: r.median24, medianMfe: r.medianMfe, medianMdd: r.medianMdd, coverage: r.coverage,
    reason: result.reason,
  }];
  for (const c of result.candidates.slice(0, Math.max(1, limit))) rows.push({
    rowType: 'CANDIDATE', status: c.n >= result.minCandidate ? 'ELIGIBLE_SAMPLE' : 'LOW_SAMPLE', samples: result.totalSamples,
    score: b.score, confidence: b.confidence, liquidity: b.liquidity,
    recommendedScore: c.score, recommendedConfidence: c.confidence, recommendedLiquidity: c.liquidity,
    candidateSamples: c.n, utility: result.base.utility, recommendedUtility: c.adjustedUtility,
    deltaUtility: c.adjustedUtility - result.base.utility,
    cleanWin30Rate: c.clean, hit50Rate: c.hit50, hit100Rate: c.hit100, fail30Rate: c.fail30,
    median24h: c.median24, medianMfe: c.medianMfe, medianMdd: c.medianMdd, coverage: c.coverage,
    reason: '仅供比较；生产阈值不会自动修改',
  });
  return rows;
}
