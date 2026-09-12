import assert from 'node:assert/strict';
import { evaluateSecondLeg } from './second_leg_alert_worker.mjs';

const baseItem={symbol:'TEST',address:'0x1111111111111111111111111111111111111111',preferredPair:'0xabc',athPriceUsd:1};
const strong={ok:true,pairId:'0xabc',price:0.30,liquidity:600000,volumeH1:80000,volumeH24:700000,amountRatio:1.8,buys:120,sells:70,txnRatio:120/70,h1Multiplier:80000/(700000/24),priceChangeH1:8,priceChangeM5:2};
const clear={riskGate:'CLEAR'};
const a=evaluateSecondLeg(baseItem,strong,clear);
assert.equal(a.eligible,true,'strong second-leg setup should be eligible');
assert.ok(a.score>=70);
assert.ok(a.confidence>=70);

const blocked=evaluateSecondLeg(baseItem,strong,{riskGate:'BLOCK'});
assert.equal(blocked.eligible,false,'BLOCK risk must never alert');

const weakFlow=evaluateSecondLeg(baseItem,{...strong,amountRatio:0.8},clear);
assert.equal(weakFlow.eligible,false,'weak money flow must not alert');

const thinLp=evaluateSecondLeg(baseItem,{...strong,liquidity:100000},clear);
assert.equal(thinLp.eligible,false,'LP below hard execution floor must not alert');

const migrated=evaluateSecondLeg(baseItem,{...strong,pairId:'0xdef'},clear);
assert.equal(migrated.eligible,false,'pool migration must lock signal');
assert.equal(migrated.pairMigration,true);

const noAth=evaluateSecondLeg({...baseItem,athPriceUsd:null},strong,clear);
assert.equal(noAth.eligible,false,'missing same-pool ATH must not alert');

console.log('second-leg alert check ok');
