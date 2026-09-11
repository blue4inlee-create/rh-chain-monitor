// Stage 1 validation for Opportunity Pool
// Discovery -> Storage -> Export

export function validateOpportunityStage1(record = {}) {
  const checks = {
    hasCA: Boolean(record.ca || record.address || record.token_address),
    hasFirstSeen: Boolean(record.firstSeen || record.first_seen_at),
    hasStage: Boolean(record.stage),
    hasSource: Boolean(record.source),
    hasScoreField: Object.prototype.hasOwnProperty.call(record, 'score'),
    hasHistoryFields:
      Object.prototype.hasOwnProperty.call(record, 'athPrice') ||
      Object.prototype.hasOwnProperty.call(record, 'ath_price') ||
      Object.prototype.hasOwnProperty.call(record, 'ath'),
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
  };
}

export const STAGE1_REQUIREMENTS = [
  'discovery_ingest',
  'ca_deduplication',
  'first_seen_preservation',
  'raw_pool_separation',
  'score_reserved',
  'history_reserved',
  'export_ready'
];
