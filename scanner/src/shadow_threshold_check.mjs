import { SHADOW_PROFILES } from './shadow_threshold_pool.mjs';

function assert(ok, message) { if (!ok) throw new Error(message); }

assert(SHADOW_PROFILES.length === 8, 'expected 8 shadow profiles');
assert(new Set(SHADOW_PROFILES.map(p => p.id)).size === SHADOW_PROFILES.length, 'profile ids must be unique');
assert(SHADOW_PROFILES.some(p => p.score === 55 && p.confidence === 50 && p.liquidity === 5000), 'missing broad 55/50/5k floor');
assert(SHADOW_PROFILES.some(p => p.score === 65 && p.confidence === 60 && p.liquidity === 10000), 'missing near-production 65/60/10k profile');
assert(SHADOW_PROFILES.every(p => p.score < 70 || p.confidence < 60 || p.liquidity < 10000), 'shadow profile must remain below production baseline');
assert(SHADOW_PROFILES.every(p => p.score >= 55 && p.confidence >= 50 && p.liquidity >= 5000), 'shadow floor too loose');

console.log('shadow threshold check ok');
