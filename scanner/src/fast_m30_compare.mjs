import { getDatabase } from './db.mjs';

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 4) {
  const n = num(v);
  if (n == null) return '';
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function yn(v) { return v ? 'Y' : 'N'; }

export function buildFastM30CompareRows() {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      f.token_address,
      COALESCE(t.symbol, '') AS symbol,
      f.first_seen_at,
      f.m30_at,
      f.m30_age_sec,
      f.score_v2,
      f.shadow_entry_price_usd AS fast_entry_price,
      f.shadow_entry_market_cap AS fast_entry_mc,
      t.canary_at,
      t.canary_price_usd AS canary_entry_price,
      t.canary_market_cap AS canary_entry_mc,
      t.first_source,
      (
        SELECT x.at FROM (
          SELECT mt.tick_at AS at, mt.price_usd AS price
          FROM market_ticks mt
          WHERE mt.token_address=f.token_address AND mt.tick_at>=f.shadow_entry_at AND mt.price_usd IS NOT NULL
          UNION ALL
          SELECT s.snapshot_at AS at, s.price_usd AS price
          FROM snapshots s
          WHERE s.token_address=f.token_address AND s.snapshot_at>=f.shadow_entry_at AND s.price_usd IS NOT NULL
        ) x ORDER BY x.at DESC LIMIT 1
      ) AS fast_last_obs_at,
      (
        SELECT x.price FROM (
          SELECT mt.tick_at AS at, mt.price_usd AS price
          FROM market_ticks mt
          WHERE mt.token_address=f.token_address AND mt.tick_at>=f.shadow_entry_at AND mt.price_usd IS NOT NULL
          UNION ALL
          SELECT s.snapshot_at AS at, s.price_usd AS price
          FROM snapshots s
          WHERE s.token_address=f.token_address AND s.snapshot_at>=f.shadow_entry_at AND s.price_usd IS NOT NULL
        ) x ORDER BY x.at DESC LIMIT 1
      ) AS fast_last_price,
      MAX(
        COALESCE((SELECT MAX(mt.price_usd) FROM market_ticks mt WHERE mt.token_address=f.token_address AND mt.tick_at>=f.shadow_entry_at), 0),
        COALESCE((SELECT MAX(s.price_usd) FROM snapshots s WHERE s.token_address=f.token_address AND s.snapshot_at>=f.shadow_entry_at), 0),
        COALESCE(f.shadow_entry_price_usd, 0)
      ) AS fast_peak_price,
      CASE WHEN t.canary_at IS NULL THEN NULL ELSE (
        SELECT x.at FROM (
          SELECT mt.tick_at AS at, mt.price_usd AS price
          FROM market_ticks mt
          WHERE mt.token_address=f.token_address AND mt.tick_at>=t.canary_at AND mt.price_usd IS NOT NULL
          UNION ALL
          SELECT s.snapshot_at AS at, s.price_usd AS price
          FROM snapshots s
          WHERE s.token_address=f.token_address AND s.snapshot_at>=t.canary_at AND s.price_usd IS NOT NULL
        ) x ORDER BY x.at DESC LIMIT 1
      ) END AS canary_last_obs_at,
      CASE WHEN t.canary_at IS NULL THEN NULL ELSE (
        SELECT x.price FROM (
          SELECT mt.tick_at AS at, mt.price_usd AS price
          FROM market_ticks mt
          WHERE mt.token_address=f.token_address AND mt.tick_at>=t.canary_at AND mt.price_usd IS NOT NULL
          UNION ALL
          SELECT s.snapshot_at AS at, s.price_usd AS price
          FROM snapshots s
          WHERE s.token_address=f.token_address AND s.snapshot_at>=t.canary_at AND s.price_usd IS NOT NULL
        ) x ORDER BY x.at DESC LIMIT 1
      ) END AS canary_last_price,
      CASE WHEN t.canary_at IS NULL THEN NULL ELSE MAX(
        COALESCE((SELECT MAX(mt.price_usd) FROM market_ticks mt WHERE mt.token_address=f.token_address AND mt.tick_at>=t.canary_at), 0),
        COALESCE((SELECT MAX(s.price_usd) FROM snapshots s WHERE s.token_address=f.token_address AND s.snapshot_at>=t.canary_at), 0),
        COALESCE(t.canary_price_usd, 0)
      ) END AS canary_peak_price
    FROM fast_m30_shadow f
    JOIN tokens t ON t.token_address=f.token_address
    WHERE f.qualifies_canary1=1
      AND f.m30_age_sec BETWEEN 20 AND 35
      AND f.shadow_entry_at IS NOT NULL
      AND f.shadow_entry_price_usd > 0
      AND f.shadow_entry_market_cap > 0
    ORDER BY f.shadow_entry_at ASC
  `).all();

  const headers = [
    'Symbol','CA','First Seen','Fast M30时间','Fast M30秒','Fast Score','Fast M30市值',
    '生产Canary时间','生产Canary市值','Fast提前秒','CanaryMC/FastMC',
    'Fast观察分钟','Fast当前x','Fast最高x','Fast>=1.2x','Fast>=2x','Fast误报',
    'Canary观察分钟','Canary当前x','Canary最高x','Canary>=1.2x','Canary>=2x','Canary误报','来源'
  ];

  const out = rows.map(r => {
    const fastEntryPrice = num(r.fast_entry_price);
    const fastLastPrice = num(r.fast_last_price) ?? fastEntryPrice;
    const fastPeakPrice = num(r.fast_peak_price) ?? fastEntryPrice;
    const canaryEntryPrice = num(r.canary_entry_price);
    const canaryLastPrice = num(r.canary_last_price) ?? canaryEntryPrice;
    const canaryPeakPrice = num(r.canary_peak_price) ?? canaryEntryPrice;
    const fastObsMin = r.fast_last_obs_at && r.m30_at
      ? (new Date(r.fast_last_obs_at).getTime() - new Date(r.m30_at).getTime()) / 60000 : 0;
    const canaryObsMin = r.canary_last_obs_at && r.canary_at
      ? (new Date(r.canary_last_obs_at).getTime() - new Date(r.canary_at).getTime()) / 60000 : null;
    const fastCurrent = fastEntryPrice > 0 && fastLastPrice != null ? fastLastPrice / fastEntryPrice : null;
    const fastMax = fastEntryPrice > 0 && fastPeakPrice != null ? fastPeakPrice / fastEntryPrice : null;
    const canaryCurrent = canaryEntryPrice > 0 && canaryLastPrice != null ? canaryLastPrice / canaryEntryPrice : null;
    const canaryMax = canaryEntryPrice > 0 && canaryPeakPrice != null ? canaryPeakPrice / canaryEntryPrice : null;
    const leadSec = r.canary_at && r.m30_at
      ? (new Date(r.canary_at).getTime() - new Date(r.m30_at).getTime()) / 1000 : null;
    const entryRatio = num(r.canary_entry_mc) > 0 && num(r.fast_entry_mc) > 0
      ? Number(r.canary_entry_mc) / Number(r.fast_entry_mc) : null;
    const fastMature = fastObsMin >= 30;
    const canaryMature = canaryObsMin != null && canaryObsMin >= 30;
    // Mirror the Sheet scorecard false-positive rule: after 30m, max <1.2x and current <0.6x.
    const fastFalse = fastMature && fastMax != null && fastMax < 1.2 && fastCurrent != null && fastCurrent < 0.6;
    const canaryFalse = canaryMature && canaryMax != null && canaryMax < 1.2 && canaryCurrent != null && canaryCurrent < 0.6;

    return [
      r.symbol || '', r.token_address, r.first_seen_at || '', r.m30_at || '', round(r.m30_age_sec, 3), round(r.score_v2, 1), round(r.fast_entry_mc, 2),
      r.canary_at || '', round(r.canary_entry_mc, 2), round(leadSec, 3), round(entryRatio, 4),
      round(fastObsMin, 2), round(fastCurrent, 4), round(fastMax, 4), fastMature ? yn(fastMax >= 1.2) : '', fastMature ? yn(fastMax >= 2) : '', fastMature ? yn(fastFalse) : '',
      canaryObsMin == null ? '' : round(canaryObsMin, 2), round(canaryCurrent, 4), round(canaryMax, 4), canaryMature ? yn(canaryMax >= 1.2) : '', canaryMature ? yn(canaryMax >= 2) : '', canaryMature ? yn(canaryFalse) : '', r.first_source || ''
    ];
  });

  return [headers, ...out];
}
