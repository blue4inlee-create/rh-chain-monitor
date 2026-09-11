import assert from 'node:assert/strict';
import { evaluateEarlyAlpha } from './alert_worker.mjs';

const pass = evaluateEarlyAlpha({
  stage: 'CANARY',
  classification: 'early_alpha',
  score: 76,
  score_confidence: 82,
  liquidity: 45000,
  risk_gate: 'CLEAR',
  buy_blocked: 0,
  hard_fail_count: 0,
  payload: JSON.stringify({ riskPenalty: 4, riskFlags: [] }),
  risk_reasons: '[]',
});
assert.equal(pass.eligible, true);
assert.equal(pass.instant, false);

const instant = evaluateEarlyAlpha({
  stage: 'CANARY',
  classification: 'confirm_watch',
  score: 88,
  score_confidence: 80,
  liquidity: 60000,
  risk_gate: 'CLEAR',
  buy_blocked: 0,
  hard_fail_count: 0,
  payload: JSON.stringify({ riskPenalty: 2, riskFlags: [] }),
  risk_reasons: '[]',
});
assert.equal(instant.eligible, true);
assert.equal(instant.instant, true);

const blocked = evaluateEarlyAlpha({
  stage: 'CANARY',
  classification: 'early_alpha',
  score: 90,
  score_confidence: 90,
  liquidity: 100000,
  risk_gate: 'BLOCK',
  buy_blocked: 1,
  hard_fail_count: 1,
  payload: JSON.stringify({ riskPenalty: 30, riskFlags: ['honeypot'] }),
});
assert.equal(blocked.eligible, false);

const discovery = evaluateEarlyAlpha({
  stage: 'DISCOVERY',
  classification: 'early_alpha',
  score: 90,
  score_confidence: 90,
  liquidity: 100000,
  risk_gate: 'CLEAR',
});
assert.equal(discovery.eligible, false);

console.log('alert worker check ok');
