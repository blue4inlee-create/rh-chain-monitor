// Opportunity Pool v2
// Central layer for candidates that are worth manual review.

import { scoreOpportunity, classifyOpportunityScore } from './opportunity_score.mjs';

const DEFAULT_STATUS = 'watching';

export function normalizeOpportunity(input = {}) {
  const base = {
    address: String(input.address || input.ca || '').toLowerCase(),
    symbol: input.symbol || '',
    name: input.name || '',
    source: input.source || 'scanner',
    stage: input.stage || 'discovery',
    status: input.status || DEFAULT_STATUS,
    marketCap: Number(input.marketCap || 0),
    liquidity: Number(input.liquidity || 0),
    volume24h: Number(input.volume24h || 0),
    holders: Number(input.holders || 0),
    holderGrowth: input.holderGrowth ?? null,
    buys: input.buys ?? null,
    sells: input.sells ?? null,
    buyVolumeUsd: input.buyVolumeUsd ?? null,
    sellVolumeUsd: input.sellVolumeUsd ?? null,
    narrativeType: input.narrativeType || input.type || '',
    isApplication: Boolean(input.isApplication),
    isPlatform: Boolean(input.isPlatform),
    hasProduct: Boolean(input.hasProduct),
    hasRevenue: Boolean(input.hasRevenue),
    top10HolderPct: input.top10HolderPct ?? null,
    devHolderPct: input.devHolderPct ?? null,
    devNewWallet: Boolean(input.devNewWallet),
    firstPostIsCa: Boolean(input.firstPostIsCa),
    honeypot: Boolean(input.honeypot),
    blacklistRisk: Boolean(input.blacklistRisk),
    mintRisk: Boolean(input.mintRisk),
    lpRisk: Boolean(input.lpRisk),
    riskFlags: Array.isArray(input.riskFlags) ? input.riskFlags : [],
    riskGate: input.riskGate || 'CAUTION',
    buyBlocked: Boolean(input.buyBlocked),
    riskConfidence: Number(input.riskConfidence || 0),
    hardFailCount: Number(input.hardFailCount || 0),
    warnCount: Number(input.warnCount || 0),
    criticalUnknownCount: Number(input.criticalUnknownCount || 0),
    criticalUnknown: Array.isArray(input.criticalUnknown) ? input.criticalUnknown : [],
    riskReasons: Array.isArray(input.riskReasons) ? input.riskReasons : [],
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: Array.isArray(input.tags) ? input.tags : [],
  };

  return scoreOpportunity(base);
}

export function buildOpportunityPool(records = []) {
  return records
    .map(normalizeOpportunity)
    .filter(item => item.address || item.symbol)
    .sort((a, b) => {
      if (a.buyBlocked !== b.buyBlocked) return a.buyBlocked ? 1 : -1;
      return b.score - a.score;
    });
}

export function classifyOpportunity(item) {
  return classifyOpportunityScore(item?.score || 0);
}
