// Opportunity Pool export bridge v3
import { getOpportunityRows } from './opportunity_repository.mjs';

function parseJson(value, fallback = {}) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

export function getOpportunityExportRows(limit = 100) {
  return getOpportunityRows(limit).map(row => {
    const payload = parseJson(row.payload, {});
    const scoreBreakdown = parseJson(row.score_breakdown, payload.scoreBreakdown || {});
    const riskReasons = parseJson(row.risk_reasons, payload.riskReasons || []);
    return {
      symbol: row.symbol,
      address: row.token_address,
      stage: row.stage,
      score: row.score,
      classification: row.classification || payload.classification || 'observe',
      scoreConfidence: row.score_confidence ?? payload.confidence ?? 0,
      scoreVersion: row.score_version || payload.scoreVersion || '',
      scoreBreakdown,
      heatScore: scoreBreakdown.heat ?? 0,
      liquidityScore: scoreBreakdown.liquidity ?? 0,
      flowScore: scoreBreakdown.flow ?? 0,
      holderScore: scoreBreakdown.holders ?? 0,
      projectScore: scoreBreakdown.project ?? 0,
      riskPenalty: scoreBreakdown.riskPenalty ?? 0,
      riskGate: row.risk_gate || payload.riskGate || 'CAUTION',
      riskConfidence: row.risk_confidence ?? payload.riskConfidence ?? 0,
      buyBlocked: Boolean(row.buy_blocked ?? payload.buyBlocked),
      hardFailCount: row.hard_fail_count ?? payload.hardFailCount ?? 0,
      warnCount: row.warn_count ?? payload.warnCount ?? 0,
      criticalUnknownCount: row.critical_unknown_count ?? payload.criticalUnknownCount ?? 0,
      riskReasons: Array.isArray(riskReasons) ? riskReasons : [],
      marketCap: row.market_cap,
      liquidity: row.liquidity,
      volume24h: row.volume24h,
      holders: row.holders,
      buys: payload.buys ?? null,
      sells: payload.sells ?? null,
      holderGrowth: payload.holderGrowth ?? null,
      narrativeType: payload.narrativeType || '',
      riskFlags: Array.isArray(payload.riskFlags) ? payload.riskFlags : [],
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      updatedAt: row.updated_at,
    };
  });
}
