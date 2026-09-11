// Opportunity Pool data layer foundation
// Stage 1: Discovery -> Opportunity Pool

const OPPORTUNITY_FIELDS = [
  'token',
  'symbol',
  'ca',
  'chain',
  'source',
  'firstSeen',
  'firstPrice',
  'currentPrice',
  'athPrice',
  'marketCap',
  'fdv',
  'liquidity',
  'volume24h',
  'buys',
  'sells',
  'holders',
  'holderGrowth',
  'devAddress',
  'devRisk',
  'narrativeType',
  'isApplication',
  'isPlatform',
  'stage',
  'riskFlags',
  'createdAt',
  'updatedAt'
];

export function normalizeOpportunity(input = {}) {
  const item = {};

  for (const field of OPPORTUNITY_FIELDS) {
    item[field] = input[field] ?? null;
  }

  item.chain = item.chain || 'Robinhood Chain';
  item.stage = item.stage || 'Discovery';
  item.riskFlags = Array.isArray(item.riskFlags) ? item.riskFlags : [];

  return item;
}

export function opportunityKey(item) {
  return String(item.ca || '').toLowerCase();
}

export function mergeOpportunity(oldItem, newItem) {
  return normalizeOpportunity({
    ...oldItem,
    ...newItem,
    ca: oldItem?.ca || newItem?.ca,
    firstSeen: oldItem?.firstSeen || newItem?.firstSeen,
    createdAt: oldItem?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

export { OPPORTUNITY_FIELDS };
