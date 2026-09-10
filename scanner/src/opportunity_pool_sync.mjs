// Opportunity Pool data bridge v1
// Aggregates existing scanner outputs into trading candidates.

import { normalizeOpportunity, buildOpportunityPool } from './opportunity_pool.mjs';

export function buildOpportunityCandidates({ tokens = [], snapshots = [], fastM30 = [], canary = [] } = {}) {
  const snapshotMap = new Map(snapshots.map(x => [x.token_address || x.address, x]));
  const fastMap = new Map(fastM30.map(x => [x.token_address || x.address, x]));
  const canaryMap = new Map(canary.map(x => [x.token_address || x.address, x]));

  const rows = tokens.map(token => {
    const key = token.token_address || token.address;
    const snapshot = snapshotMap.get(key) || {};
    const fast = fastMap.get(key) || {};
    const stage = canaryMap.get(key)?.stage || token.stage || 'discovery';

    return normalizeOpportunity({
      address: key,
      symbol: token.symbol,
      source: token.first_source || 'scanner',
      stage,
      marketCap: snapshot.market_cap || snapshot.marketCap,
      liquidity: snapshot.liquidity_usd || snapshot.liquidity,
      volume24h: snapshot.volume_total_usd || snapshot.volume24h,
      holders: snapshot.holder_count || snapshot.holders,
      score: fast.score || token.score || 0,
      tags: ['rh', stage]
    });
  });

  return buildOpportunityPool(rows);
}
