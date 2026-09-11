// Opportunity Score v1.1
// Portfolio ranking score for Opportunity Pool. Independent from scanner score-v1/v2.

export const OPPORTUNITY_SCORE_VERSION = 'opportunity-score-v1.1';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(v) || 0));
const num = v => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = v => v === true || v === 1 || String(v).toLowerCase() === 'true';

function scaled(value, stops = []) {
  const v = num(value);
  if (v == null) return 0;
  for (const [limit, score] of stops) {
    if (v < limit) return score;
  }
  return stops.length ? stops[stops.length - 1][1] : 0;
}

function heatScore(item) {
  const volume = scaled(item.volume24h, [
    [1_000, 1], [5_000, 4], [20_000, 8], [75_000, 13], [250_000, 18], [Infinity, 20],
  ]);
  const trades = (num(item.buys) || 0) + (num(item.sells) || 0);
  const tradeScore = scaled(trades, [
    [10, 0], [30, 1], [100, 2], [300, 4], [Infinity, 5],
  ]);
  return clamp(volume + tradeScore, 0, 25);
}

function liquidityScore(item) {
  const liquidity = num(item.liquidity);
  const marketCap = num(item.marketCap);
  let base = scaled(liquidity, [
    [2_000, 1], [5_000, 4], [15_000, 8], [50_000, 12], [150_000, 15], [Infinity, 17],
  ]);
  if (liquidity != null && marketCap != null && marketCap > 0) {
    const ratio = liquidity / marketCap;
    if (ratio >= 0.25) base += 3;
    else if (ratio >= 0.12) base += 2;
    else if (ratio >= 0.05) base += 1;
  }
  return clamp(base, 0, 20);
}

function flowScore(item) {
  const buys = num(item.buys);
  const sells = num(item.sells);
  const buyVolume = num(item.buyVolumeUsd);
  const sellVolume = num(item.sellVolumeUsd);

  let score = 0;
  if (buys != null || sells != null) {
    const b = buys || 0;
    const s = sells || 0;
    const total = b + s;
    if (total > 0) {
      const buyShare = b / total;
      if (buyShare >= 0.72) score += 7;
      else if (buyShare >= 0.62) score += 5;
      else if (buyShare >= 0.54) score += 3;
      else if (buyShare < 0.40) score -= 3;
    }
  }
  if (buyVolume != null || sellVolume != null) {
    const net = (buyVolume || 0) - (sellVolume || 0);
    const gross = (buyVolume || 0) + (sellVolume || 0);
    if (gross > 0) {
      const netShare = net / gross;
      if (netShare >= 0.35) score += 8;
      else if (netShare >= 0.18) score += 6;
      else if (netShare > 0) score += 3;
      else if (netShare <= -0.25) score -= 5;
    }
  }
  return clamp(score, 0, 15);
}

function holderScore(item) {
  const holders = num(item.holders);
  const growth = num(item.holderGrowth);
  let score = scaled(holders, [
    [20, 0], [50, 2], [150, 4], [500, 6], [1500, 8], [Infinity, 9],
  ]);
  if (growth != null) {
    if (growth >= 50) score += 6;
    else if (growth >= 20) score += 5;
    else if (growth >= 8) score += 4;
    else if (growth > 0) score += 2;
    else if (growth < -10) score -= 3;
  }
  return clamp(score, 0, 15);
}

function projectScore(item) {
  let score = 0;
  const type = String(item.narrativeType || item.type || '').toLowerCase();
  if (bool(item.isApplication) || /app|application|utility/.test(type)) score += 6;
  if (bool(item.isPlatform) || /platform|launchpad/.test(type)) score += 4;
  if (/defi|dex|lending|perp|yield|liquidity/.test(type)) score += 4;
  if (/rwa|stock|equity/.test(type)) score += 3;
  if (bool(item.hasProduct)) score += 3;
  if (bool(item.hasRevenue)) score += 2;
  if (/meme/.test(type) && !bool(item.hasProduct)) score -= 3;
  return clamp(score, 0, 15);
}

function riskPenalty(item) {
  let penalty = 0;
  const flags = Array.isArray(item.riskFlags) ? item.riskFlags.map(x => String(x).toLowerCase()) : [];
  const text = flags.join('|');

  if (bool(item.buyBlocked) || String(item.riskGate || '').toUpperCase() === 'BLOCK') penalty += 30;
  if (bool(item.honeypot) || /honeypot/.test(text)) penalty += 30;
  if (bool(item.blacklistRisk) || /blacklist/.test(text)) penalty += 18;
  if (bool(item.mintRisk) || /mint/.test(text)) penalty += 12;
  if (bool(item.devNewWallet) || /dev[_ -]?new|new[_ -]?wallet/.test(text)) penalty += 8;
  if (bool(item.firstPostIsCa) || /first[_ -]?post.*ca|first.*ca/.test(text)) penalty += 8;
  if (bool(item.lpRisk) || /lp[_ -]?risk|liquidity.*risk/.test(text)) penalty += 10;

  const top10 = num(item.top10HolderPct);
  if (top10 != null) {
    if (top10 >= 80) penalty += 18;
    else if (top10 >= 65) penalty += 12;
    else if (top10 >= 50) penalty += 6;
  }
  const devPct = num(item.devHolderPct);
  if (devPct != null) {
    if (devPct >= 20) penalty += 15;
    else if (devPct >= 10) penalty += 8;
    else if (devPct >= 5) penalty += 4;
  }
  return clamp(penalty, 0, 30);
}

function confidenceScore(item) {
  const fields = [
    item.marketCap,
    item.liquidity,
    item.volume24h,
    item.holders,
    item.buys,
    item.sells,
    item.holderGrowth,
    item.narrativeType ?? item.type,
    item.riskFlags,
  ];
  const present = fields.filter(v => Array.isArray(v) ? v.length > 0 : v !== '' && v != null).length;
  return clamp(Math.round((present / fields.length) * 100), 0, 100);
}

export function classifyOpportunityScore(score) {
  const s = clamp(score);
  if (s >= 85) return 'confirm_watch';
  if (s >= 70) return 'early_alpha';
  if (s >= 50) return 'watch';
  return 'observe';
}

export function calculateOpportunityScore(item = {}) {
  const heat = heatScore(item);
  const liquidity = liquidityScore(item);
  const flow = flowScore(item);
  const holders = holderScore(item);
  const project = projectScore(item);
  const risk = riskPenalty(item);
  const raw = heat + liquidity + flow + holders + project - risk;
  const score = clamp(Math.round(raw * 10) / 10, 0, 100);
  const confidence = confidenceScore(item);

  return {
    score,
    classification: classifyOpportunityScore(score),
    confidence,
    scoreVersion: OPPORTUNITY_SCORE_VERSION,
    scoreBreakdown: {
      heat,
      liquidity,
      flow,
      holders,
      project,
      riskPenalty: risk,
      positiveTotal: heat + liquidity + flow + holders + project,
      finalScore: score,
    },
  };
}

export function scoreOpportunity(item = {}) {
  return { ...item, ...calculateOpportunityScore(item) };
}
