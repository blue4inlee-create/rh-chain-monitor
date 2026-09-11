import { optimizeThresholds } from './threshold_optimizer.mjs';

function assert(ok, message) { if (!ok) throw new Error(message); }

const rows = [];
for (let i = 0; i < 40; i += 1) {
  const elite = i < 18;
  rows.push({
    event_type: 'EARLY_ALPHA',
    status: 'COMPLETE',
    data_quality: 'GOOD',
    score: elite ? 82 : 72,
    confidence: elite ? 76 : 62,
    entry_liquidity: elite ? 60000 : 12000,
    clean_win_30: elite ? 1 : (i % 4 === 0 ? 1 : 0),
    hit_50: elite ? 1 : (i % 6 === 0 ? 1 : 0),
    hit_100: elite ? (i % 2 === 0 ? 1 : 0) : 0,
    hit_minus30: elite ? 0 : (i % 2 === 0 ? 1 : 0),
    h24_return_pct: elite ? 85 : -15,
    max_runup_pct: elite ? 130 : 18,
    max_drawdown_pct: elite ? -18 : -48,
  });
}

const result = optimizeThresholds(rows, {
  score: 70,
  confidence: 60,
  liquidity: 10000,
  minTotal: 30,
  minCandidate: 12,
  minDelta: 5,
});

assert(result.totalSamples === 40, 'sample count mismatch');
assert(result.status === 'READY_TO_APPLY', `expected READY_TO_APPLY, got ${result.status}`);
assert(result.recommendation.score >= 75, 'score should tighten');
assert(result.recommendation.confidence >= 70, 'confidence should tighten');
assert(result.recommendation.liquidity >= 20000, 'liquidity should tighten');

const warmup = optimizeThresholds(rows.slice(0, 10), { minTotal: 30, minCandidate: 8 });
assert(warmup.status === 'WARMUP', 'small sample should stay warmup');
console.log('threshold optimizer check ok');
