// Discovery -> Opportunity Pool unified ingest bridge
// Stage 1 data layer

import { normalizeOpportunity, opportunityKey, mergeOpportunity } from './opportunity_repository.mjs';

const memoryPool = new Map();

export function ingestDiscoveryRecord(raw = {}) {
  const normalized = normalizeOpportunity({
    ...raw,
    source: raw.source || raw.factory || 'discovery',
    ca: String(raw.ca || raw.address || '').toLowerCase()
  });

  if (!normalized.ca) return null;

  const key = opportunityKey(normalized);
  const existing = memoryPool.get(key);

  // CA is immutable. First Seen only accepts earliest discovery time.
  const merged = existing
    ? mergeOpportunity(existing, normalized)
    : normalizeOpportunity({
        ...normalized,
        firstSeen: normalized.firstSeen || new Date().toISOString()
      });

  merged.firstSeen = existing?.firstSeen || merged.firstSeen;

  // Reserve fields for scoring model.
  merged.score = merged.score ?? null;
  merged.scoreBreakdown = merged.scoreBreakdown ?? {};

  // Reserve fields for historical evaluation.
  merged.performance = merged.performance ?? {
    m5: null,
    m30: null,
    h2: null,
    athMultiple: null,
    maxDrawdown: null
  };

  memoryPool.set(key, merged);
  return merged;
}

export function getOpportunityPool() {
  return Array.from(memoryPool.values());
}
