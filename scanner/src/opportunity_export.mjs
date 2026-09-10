// Opportunity Pool export bridge v1
import { getOpportunityRows } from './opportunity_repository.mjs';

export function getOpportunityExportRows(limit = 100) {
  return getOpportunityRows(limit).map(row => ({
    symbol: row.symbol,
    address: row.token_address,
    stage: row.stage,
    score: row.score,
    marketCap: row.market_cap,
    liquidity: row.liquidity,
    volume24h: row.volume24h,
    holders: row.holders,
    tags: row.tags,
    updatedAt: row.updated_at,
  }));
}
