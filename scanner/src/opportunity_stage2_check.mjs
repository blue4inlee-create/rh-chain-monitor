import { calculateOpportunityScore, classifyOpportunityScore } from './opportunity_score.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const strong = calculateOpportunityScore({
  marketCap: 220000,
  liquidity: 65000,
  volume24h: 180000,
  buys: 240,
  sells: 90,
  buyVolumeUsd: 120000,
  sellVolumeUsd: 45000,
  holders: 850,
  holderGrowth: 24,
  narrativeType: 'defi application',
  isApplication: true,
  hasProduct: true,
  hasRevenue: true,
  riskFlags: [],
});

const weak = calculateOpportunityScore({
  marketCap: 50000,
  liquidity: 1800,
  volume24h: 900,
  buys: 8,
  sells: 25,
  holders: 18,
  holderGrowth: -12,
  narrativeType: 'meme',
  devNewWallet: true,
  firstPostIsCa: true,
  lpRisk: true,
  top10HolderPct: 82,
  devHolderPct: 22,
  riskFlags: ['dev_new_wallet', 'first_post_ca', 'lp_risk'],
});

assert(strong.score > weak.score, 'strong candidate must outrank weak candidate');
assert(strong.scoreBreakdown.riskPenalty === 0, 'clean candidate should have zero risk penalty');
assert(weak.scoreBreakdown.riskPenalty > 0, 'risky candidate must receive penalty');
assert(['confirm_watch', 'early_alpha', 'watch', 'observe'].includes(strong.classification), 'classification invalid');
assert(classifyOpportunityScore(85) === 'confirm_watch', '85 threshold mismatch');
assert(classifyOpportunityScore(70) === 'early_alpha', '70 threshold mismatch');
assert(classifyOpportunityScore(50) === 'watch', '50 threshold mismatch');
assert(classifyOpportunityScore(49.9) === 'observe', 'observe threshold mismatch');

console.log(JSON.stringify({
  ok: true,
  strong,
  weak,
}, null, 2));
