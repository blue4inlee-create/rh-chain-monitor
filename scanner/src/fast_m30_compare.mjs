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
    WITH canonical_pool AS (
      SELECT token_address,pool_key FROM (
        SELECT token_address,pool_key,MAX(liquidity_usd) AS max_liq,
               ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY MAX(liquidity_usd) DESC) AS rn
        FROM market_ticks
        WHERE source<>'pons-curve' AND pool_key<>'' AND liquidity_usd IS NOT NULL
        GROUP BY token_address,pool_key
      ) WHERE rn=1
    ),
    qualified_obs AS (
      SELECT mt.token_address,mt.tick_at AS at,mt.market_cap AS mc
      FROM market_ticks mt
      LEFT JOIN canonical_pool cp ON cp.token_address=mt.token_address
      WHERE mt.market_cap IS NOT NULL AND mt.market_cap>0 AND (
        (mt.source='pons-curve' AND COALESCE(CAST(json_extract(mt.raw_data,'$.reserveUsd') AS REAL),0)>=2500)
        OR
        (mt.source<>'pons-curve' AND mt.liquidity_usd>=10000 AND lower(mt.pool_key)=lower(cp.pool_key))
      )
      UNION ALL
      SELECT s.token_address,s.snapshot_at AS at,s.market_cap AS mc
      FROM snapshots s
      LEFT JOIN canonical_pool cp ON cp.token_address=s.token_address
      WHERE s.market_cap IS NOT NULL AND s.market_cap>0 AND (
        (s.source_status LIKE '%PONS_CURVE_OK%' AND COALESCE(CAST(json_extract(s.raw_data,'$.pons.reserveUsd') AS REAL),0)>=2500)
        OR
        (s.liquidity_usd>=10000 AND lower(s.pair_address)=lower(cp.pool_key))
      )
    )
    SELECT
      f.token_address,
      COALESCE(t.symbol, '') AS symbol,
      f.first_seen_at,
      f.m30_at,
      f.m30_age_sec,
      f.score_v2,
      f.shadow_entry_market_cap AS fast_entry_mc,
      t.canary_at,
      t.canary_market_cap AS canary_entry_mc,
      t.first_source,
      (
        SELECT x.at FROM qualified_obs x
        WHERE x.token_address=f.token_address AND x.at>=f.shadow_entry_at
        ORDER BY x.at DESC LIMIT 1
      ) AS fast_last_obs_at,
      (
        SELECT x.mc FROM qualified_obs x
        WHERE x.token_address=f.token_address AND x.at>=f.shadow_entry_at
        ORDER BY x.at DESC LIMIT 1
      ) AS fast_last_mc,
      COALESCE((
        SELECT MAX(x.mc) FROM qualified_obs x
        WHERE x.token_address=f.token_address AND x.at>=f.shadow_entry_at
      ), f.shadow_entry_market_cap) AS fast_peak_mc,
      CASE WHEN t.canary_at IS NULL THEN NULL ELSE (
        SELECT x.at FROM qualified_obs x
        WHERE x.token_address=f.token_address AND x.at>=t.canary_at
        ORDER BY x.at DESC LIMIT 1
      ) END AS canary_last_obs_at,
      CASE WHEN t.canary_at IS NULL THEN NULL ELSE (
        SELECT x.mc FROM qualified_obs x
        WHERE x.token_address=f.token_address AND x.at>=t.canary_at
        ORDER BY x.at DESC LIMIT 1
      ) END AS canary_last_mc,
      CASE WHEN t.canary_at IS NULL THEN NULL ELSE COALESCE((
        SELECT MAX(x.mc) FROM qualified_obs x
        WHERE x.token_address=f.token_address AND x.at>=t.canary_at
      ), t.canary_market_cap) END AS canary_peak_mc
    FROM fast_m30_shadow f
    JOIN tokens t ON t.token_address=f.token_address
    WHERE f.qualifies_canary1=1
      AND f.m30_age_sec BETWEEN 20 AND 35
      AND f.shadow_entry_at IS NOT NULL
      AND f.shadow_entry_market_cap > 0
    ORDER BY f.shadow_entry_at ASC
  `).all();

  const headers = [
    'Symbol','CA','First Seen','Fast M30时间','Fast M30秒','Fast Score','Fast M30市值',
    '生产Canary时间','生产Canary市值','Fast提前秒','CanaryMC/FastMC',
    'Fast观察分钟','Fast当前MCx','Fast最高MCx','Fast>=1.2x','Fast>=2x','Fast误报',
    'Canary观察分钟','Canary当前MCx','Canary最高MCx','Canary>=1.2x','Canary>=2x','Canary误报','来源'
  ];

  const out = rows.map(r => {
    const fastEntryMc = num(r.fast_entry_mc);
    const fastLastMc = num(r.fast_last_mc) ?? fastEntryMc;
    const fastPeakMc = num(r.fast_peak_mc) ?? fastEntryMc;
    const canaryEntryMc = num(r.canary_entry_mc);
    const canaryLastMc = num(r.canary_last_mc) ?? canaryEntryMc;
    const canaryPeakMc = num(r.canary_peak_mc) ?? canaryEntryMc;
    const fastObsMin = r.fast_last_obs_at && r.m30_at
      ? (new Date(r.fast_last_obs_at).getTime() - new Date(r.m30_at).getTime()) / 60000 : 0;
    const canaryObsMin = r.canary_last_obs_at && r.canary_at
      ? (new Date(r.canary_last_obs_at).getTime() - new Date(r.canary_at).getTime()) / 60000 : null;
    const fastCurrent = fastEntryMc > 0 && fastLastMc != null ? fastLastMc / fastEntryMc : null;
    const fastMax = fastEntryMc > 0 && fastPeakMc != null ? fastPeakMc / fastEntryMc : null;
    const canaryCurrent = canaryEntryMc > 0 && canaryLastMc != null ? canaryLastMc / canaryEntryMc : null;
    const canaryMax = canaryEntryMc > 0 && canaryPeakMc != null ? canaryPeakMc / canaryEntryMc : null;
    const leadSec = r.canary_at && r.m30_at
      ? (new Date(r.canary_at).getTime() - new Date(r.m30_at).getTime()) / 1000 : null;
    const entryRatio = canaryEntryMc > 0 && fastEntryMc > 0 ? canaryEntryMc / fastEntryMc : null;
    const fastMature = fastObsMin >= 30;
    const canaryMature = canaryObsMin != null && canaryObsMin >= 30;
    const fastFalse = fastMature && fastMax != null && fastMax < 1.2 && fastCurrent != null && fastCurrent < 0.6;
    const canaryFalse = canaryMature && canaryMax != null && canaryMax < 1.2 && canaryCurrent != null && canaryCurrent < 0.6;

    return [
      r.symbol || '', r.token_address, r.first_seen_at || '', r.m30_at || '', round(r.m30_age_sec, 3), round(r.score_v2, 1), round(fastEntryMc, 2),
      r.canary_at || '', round(canaryEntryMc, 2), round(leadSec, 3), round(entryRatio, 4),
      round(fastObsMin, 2), round(fastCurrent, 4), round(fastMax, 4), fastMature ? yn(fastMax >= 1.2) : '', fastMature ? yn(fastMax >= 2) : '', fastMature ? yn(fastFalse) : '',
      canaryObsMin == null ? '' : round(canaryObsMin, 2), round(canaryCurrent, 4), round(canaryMax, 4), canaryMature ? yn(canaryMax >= 1.2) : '', canaryMature ? yn(canaryMax >= 2) : '', canaryMature ? yn(canaryFalse) : '', r.first_source || ''
    ];
  });

  return [headers, ...out];
}
