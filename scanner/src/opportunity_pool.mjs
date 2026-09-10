// Opportunity Pool v1
// Central layer for candidates that are worth manual review.

const DEFAULT_STATUS = 'watching';

export function normalizeOpportunity(input = {}) {
  return {
    address: input.address || input.ca || '',
    symbol: input.symbol || '',
    name: input.name || '',
    source: input.source || 'scanner',
    stage: input.stage || 'discovery',
    status: input.status || DEFAULT_STATUS,
    marketCap: Number(input.marketCap || 0),
    liquidity: Number(input.liquidity || 0),
    volume24h: Number(input.volume24h || 0),
    holders: Number(input.holders || 0),
    score: Number(input.score || 0),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: Array.isArray(input.tags) ? input.tags : []
  };
}

export function buildOpportunityPool(records = []) {
  return records
    .map(normalizeOpportunity)
    .filter(item => item.address || item.symbol)
    .sort((a, b) => b.score - a.score);
}

export function classifyOpportunity(item) {
  if (item.score >= 80) return 'candidate';
  if (item.score >= 50) return 'watch';
  return 'observe';
}
