// Opportunity Pool data bridge v2
// Aggregates scanner outputs into ranked Opportunity Pool candidates.

import { normalizeOpportunity, buildOpportunityPool } from './opportunity_pool.mjs';
import { saveOpportunityRows } from './opportunity_repository.mjs';

const lc = v => String(v || '').toLowerCase();

function keyedMap(rows = []) {
  return new Map(rows.map(x => [lc(x.token_address || x.address || x.ca), x]));
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

export function buildOpportunityCandidates({ tokens = [], snapshots = [], fastM30 = [], canary = [] } = {}) {
  const snapshotMap = keyedMap(snapshots);
  const fastMap = keyedMap(fastM30);
  const canaryMap = keyedMap(canary);

  const rows = tokens.map(token => {
    const key = lc(token.token_address || token.address || token.ca);
    const snapshot = snapshotMap.get(key) || {};
    const fast = fastMap.get(key) || {};
    const canaryRow = canaryMap.get(key) || {};
    const tokenPayload = parsePayload(token.raw_payload || token.payload);
    const snapshotPayload = parsePayload(snapshot.raw_data || snapshot.payload);
    const fastPayload = parsePayload(fast.payload || fast.reason_json);
    const stage = canaryRow.stage || token.stage || 'discovery';

    const riskFlags = [
      ...(Array.isArray(tokenPayload.riskFlags) ? tokenPayload.riskFlags : []),
      ...(Array.isArray(snapshotPayload.riskFlags) ? snapshotPayload.riskFlags : []),
      ...(Array.isArray(fastPayload.riskFlags) ? fastPayload.riskFlags : []),
    ];

    return normalizeOpportunity({
      address: key,
      symbol: token.symbol,
      name: token.name,
      source: token.first_source || 'scanner',
      stage,
      marketCap: snapshot.market_cap ?? snapshot.marketCap ?? fast.market_cap ?? fast.marketCap,
      liquidity: snapshot.liquidity_usd ?? snapshot.liquidity ?? fast.liquidity_usd ?? fast.liquidity,
      volume24h: snapshot.volume_total_usd ?? snapshot.volume24h ?? fast.volume24h,
      holders: snapshot.holder_count ?? snapshot.holders ?? fast.holders,
      holderGrowth: snapshot.holder_growth_pct ?? snapshot.holderGrowth ?? fast.holder_growth_pct ?? fast.holderGrowth,
      buys: snapshot.buy_count ?? snapshot.buys ?? fast.buy_count ?? fast.buys,
      sells: snapshot.sell_count ?? snapshot.sells ?? fast.sell_count ?? fast.sells,
      buyVolumeUsd: snapshot.buy_volume_usd ?? snapshot.buyVolumeUsd ?? fast.buy_volume_usd ?? fast.buyVolumeUsd,
      sellVolumeUsd: snapshot.sell_volume_usd ?? snapshot.sellVolumeUsd ?? fast.sell_volume_usd ?? fast.sellVolumeUsd,
      narrativeType: tokenPayload.narrativeType || tokenPayload.type || canaryRow.narrativeType || '',
      isApplication: tokenPayload.isApplication ?? canaryRow.isApplication,
      isPlatform: tokenPayload.isPlatform ?? canaryRow.isPlatform,
      hasProduct: tokenPayload.hasProduct ?? canaryRow.hasProduct,
      hasRevenue: tokenPayload.hasRevenue ?? canaryRow.hasRevenue,
      top10HolderPct: snapshotPayload.top10HolderPct ?? fastPayload.top10HolderPct,
      devHolderPct: snapshotPayload.devHolderPct ?? tokenPayload.devHolderPct,
      devNewWallet: tokenPayload.devNewWallet,
      firstPostIsCa: tokenPayload.firstPostIsCa,
      honeypot: tokenPayload.honeypot ?? snapshotPayload.honeypot,
      blacklistRisk: tokenPayload.blacklistRisk ?? snapshotPayload.blacklistRisk,
      mintRisk: tokenPayload.mintRisk ?? snapshotPayload.mintRisk,
      lpRisk: tokenPayload.lpRisk ?? snapshotPayload.lpRisk,
      riskFlags,
      tags: ['rh', stage, ...(Array.isArray(canaryRow.tags) ? canaryRow.tags : [])],
    });
  });

  const pool = buildOpportunityPool(rows);
  saveOpportunityRows(pool);
  return pool;
}
