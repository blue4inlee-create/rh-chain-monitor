import { deriveCandidateStatus, SECOND_LEG_CANDIDATE_DEFAULTS } from './second_leg_candidates.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const now = Date.parse('2026-09-12T06:00:00Z');
const cfg = { ...SECOND_LEG_CANDIDATE_DEFAULTS, minAgeMs: 30 * 60_000, minPeakMultiple: 1.3, minLiquidity: 10_000 };

let r = deriveCandidateStatus({
  sourceStage: 'CANARY', canaryAt: '2026-09-12T05:50:00Z', athPriceUsd: 0.01,
  peakMultiple: 2, currentLiquidityUsd: 50_000, riskGate: 'CLEAR',
}, cfg, now);
assert(r.status === 'WARMUP' && r.reason === 'canary_age_warmup', 'young canary must warm up');

r = deriveCandidateStatus({
  sourceStage: 'CANARY', canaryAt: '2026-09-12T04:00:00Z', athPriceUsd: 0.01,
  peakMultiple: 1.1, currentLiquidityUsd: 50_000, riskGate: 'CLEAR',
}, cfg, now);
assert(r.status === 'WATCH' && r.reason === 'first_leg_not_strong_enough', 'weak first leg must stay watch');

r = deriveCandidateStatus({
  sourceStage: 'CANARY', canaryAt: '2026-09-12T04:00:00Z', athPriceUsd: 0.01,
  peakMultiple: 2, currentLiquidityUsd: 50_000, riskGate: 'CAUTION',
}, cfg, now);
assert(r.status === 'ACTIVE', 'mature strong canary should enter active library even while CAUTION');

r = deriveCandidateStatus({
  sourceStage: 'CANARY', canaryAt: '2026-09-12T04:00:00Z', athPriceUsd: 0.01,
  peakMultiple: 3, currentLiquidityUsd: 500_000, riskGate: 'BLOCK',
}, cfg, now);
assert(r.status === 'BLOCKED' && r.reason === 'risk_gate_block', 'BLOCK must never enter active candidates');

r = deriveCandidateStatus({
  sourceStage: 'MANUAL', manualOverride: 1, riskGate: 'CAUTION', athPriceUsd: null,
}, cfg, now);
assert(r.status === 'ACTIVE' && r.reason === 'manual_override', 'manual legacy override should remain available');

r = deriveCandidateStatus({
  sourceStage: 'MANUAL', manualOverride: 1, riskGate: 'BLOCK', athPriceUsd: 0.01,
}, cfg, now);
assert(r.status === 'BLOCKED', 'manual override must not bypass hard safety block');

console.log('second-leg candidate library check ok');
