import assert from 'node:assert/strict';
import { summarizeOpportunityRisk } from './opportunity_risk_gate.mjs';

const safe = summarizeOpportunityRisk({
  liquidity: 25000,
  checks: [
    ['PONS_PHASE','PASS',0], ['CREATOR_TAX','PASS',0], ['DEX_LIQUIDITY','PASS',0],
    ['SELLABILITY','PASS',0], ['MINT_AUTHORITY','PASS',0], ['BLACKLIST_LOGIC','PASS',0],
    ['OWNER_PRIVILEGES','PASS',0], ['TOP10_CONCENTRATION','PASS',0],
    ['DEV_CONCENTRATION','PASS',0], ['LP_RISK','PASS',0],
  ].map(([check_name,status,severity]) => ({ check_name,status,severity })),
});
assert.equal(safe.riskGate, 'CLEAR');
assert.equal(safe.buyBlocked, false);
assert.equal(safe.riskConfidence, 100);

const rescued = summarizeOpportunityRisk({
  liquidity: 25000,
  checks: [{ check_name:'PONS_PHASE', status:'FAIL', severity:3 }],
});
assert.equal(rescued.riskGate, 'BLOCK');
assert.equal(rescued.buyBlocked, true);

const flagged = summarizeOpportunityRisk({ liquidity: 25000, riskFlags:['honeypot'] });
assert.equal(flagged.riskGate, 'BLOCK');

const thin = summarizeOpportunityRisk({ liquidity: 500 });
assert.equal(thin.riskGate, 'BLOCK');

console.log(JSON.stringify({ ok:true, safe, rescued, flagged, thin }, null, 2));
