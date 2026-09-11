// Hard risk gate for Opportunity Pool.
// Confirmed hard failures block buy candidates; unresolved checks stay visible as caution.

const CRITICAL_CHECKS = new Set([
  'PONS_PHASE', 'CREATOR_TAX', 'DEX_LIQUIDITY',
  'SELLABILITY', 'MINT_AUTHORITY', 'BLACKLIST_LOGIC', 'OWNER_PRIVILEGES',
  'TOP10_CONCENTRATION', 'DEV_CONCENTRATION', 'LP_RISK',
]);

const HARD_FAIL_CHECKS = new Set([
  'PONS_PHASE', 'CREATOR_TAX', 'SELLABILITY',
  'MINT_AUTHORITY', 'BLACKLIST_LOGIC',
  'TOP10_CONCENTRATION', 'DEV_CONCENTRATION', 'LP_RISK',
  'EXTERNAL_HARD_FLAGS',
]);

const HARD_FLAG_RE = /honeypot|blacklist|mint[_ -]?risk|lp[_ -]?risk|sell[_ -]?(?:block|fail)|cannot[_ -]?sell|rug/i;

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export function summarizeOpportunityRisk({ checks = [], riskFlags = [], liquidity = null } = {}) {
  const latest = new Map();
  for (const row of checks || []) {
    const name = text(row.check_name || row.name).toUpperCase();
    if (!name) continue;
    latest.set(name, {
      name,
      status: text(row.status).toUpperCase() || 'UNKNOWN',
      severity: Number(row.severity || 0),
      value: text(row.value),
      details: text(row.details),
    });
  }

  const flags = [...new Set((riskFlags || []).map(text).filter(Boolean))];
  const hardFlags = flags.filter(x => HARD_FLAG_RE.test(x));
  const failChecks = [...latest.values()].filter(x => x.status === 'FAIL');
  const hardFails = failChecks.filter(x => HARD_FAIL_CHECKS.has(x.name));
  const warnings = [...latest.values()].filter(x => x.status === 'WARN');
  const criticalUnknown = [...CRITICAL_CHECKS].filter(name => !latest.has(name) || latest.get(name).status === 'UNKNOWN');

  const liq = num(liquidity);
  if (liq != null && liq > 0 && liq < 1000) {
    hardFails.push({ name: 'LIQUIDITY_HARD_FLOOR', status: 'FAIL', severity: 3, value: String(liq), details: 'Liquidity below $1,000 hard floor.' });
  }

  const block = hardFails.length > 0 || hardFlags.length > 0;
  const caution = !block && (warnings.some(x => x.severity >= 2) || criticalUnknown.length >= 3 || (liq != null && liq > 0 && liq < 5000));
  const riskGate = block ? 'BLOCK' : (caution ? 'CAUTION' : 'CLEAR');
  const resolvedCritical = [...CRITICAL_CHECKS].filter(name => latest.has(name) && latest.get(name).status !== 'UNKNOWN').length;
  const riskConfidence = Math.round((resolvedCritical / CRITICAL_CHECKS.size) * 100);

  const reasons = [
    ...hardFails.map(x => `FAIL:${x.name}`),
    ...hardFlags.map(x => `FLAG:${x}`),
    ...warnings.filter(x => x.severity >= 2).map(x => `WARN:${x.name}`),
  ];

  return {
    riskGate,
    buyBlocked: block,
    riskConfidence,
    hardFailCount: hardFails.length + hardFlags.length,
    warnCount: warnings.length,
    criticalUnknownCount: criticalUnknown.length,
    criticalUnknown,
    riskReasons: [...new Set(reasons)],
    riskFlags: flags,
  };
}

export function attachOpportunityRisk(item = {}, checks = []) {
  return { ...item, ...summarizeOpportunityRisk({ checks, riskFlags: item.riskFlags, liquidity: item.liquidity }) };
}
