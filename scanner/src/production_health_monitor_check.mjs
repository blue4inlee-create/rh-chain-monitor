import { advanceHttpsRouteState, isMarketTickStale } from './production_health_monitor.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let state = {};
state = advanceHttpsRouteState(state, {
  opportunity: { ok: false, status: 0, error: 'timeout' },
  history: { ok: true, status: 200 },
}, 2, 2);
assert(state.opportunity.failures === 1, 'first failure should be recorded');
assert(state.opportunity.incident === false, 'first failure must not alert');
assert(state.history.incident === false, 'healthy route must remain healthy');

state = advanceHttpsRouteState(state, {
  opportunity: { ok: false, status: 502 },
  history: { ok: true, status: 200 },
}, 2, 2);
assert(state.opportunity.failures === 2, 'second consecutive failure should be recorded');
assert(state.opportunity.incident === true, 'second consecutive failure should open incident');

state = advanceHttpsRouteState(state, {
  opportunity: { ok: true, status: 200 },
  history: { ok: true, status: 200 },
}, 2, 2);
assert(state.opportunity.successes === 1, 'first recovery success should be recorded');
assert(state.opportunity.incident === true, 'one success must not clear incident');

state = advanceHttpsRouteState(state, {
  opportunity: { ok: true, status: 200 },
  history: { ok: false, status: 502 },
}, 2, 2);
assert(state.opportunity.successes === 2, 'second recovery success should be recorded');
assert(state.opportunity.incident === false, 'second recovery success should clear incident');
assert(state.history.failures === 1, 'other route first failure should be recorded');
assert(state.history.incident === false, 'other route first failure must not alert');

console.log('health monitor hysteresis check ok');

const now = Date.parse('2026-09-12T15:00:00.000Z');
assert(isMarketTickStale('2026-09-12T14:56:00.000Z', now, 300_000) === false, '4 minute old market tick should remain healthy');
assert(isMarketTickStale('2026-09-12T14:54:59.000Z', now, 300_000) === true, 'market tick older than 5 minutes should be stale');
assert(isMarketTickStale(null, now, 300_000) === true, 'missing market tick must be stale');

console.log('health market-tick freshness check ok');
