import { getDatabase } from './db.mjs';

export const MILESTONES = [
  { key: 'm15', ms: 15 * 60_000, toleranceMs: 4 * 60_000 },
  { key: 'h1', ms: 60 * 60_000, toleranceMs: 8 * 60_000 },
  { key: 'h6', ms: 6 * 60 * 60_000, toleranceMs: 15 * 60_000 },
  { key: 'h24', ms: 24 * 60 * 60_000, toleranceMs: 30 * 60_000 },
];

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(price, entry) {
  const p = num(price), e = num(entry);
  if (p == null || e == null || e <= 0) return null;
  return ((p / e) - 1) * 100;
}
function median(values) {
  const xs = values.map(num).filter(v => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
}

export function ensureSignalOutcomeSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_outcomes (
      event_key TEXT PRIMARY KEY,
      event_type TEXT NOT NULL DEFAULT 'EARLY_ALPHA',
      token_address TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      triggered_at TEXT NOT NULL,
      entry_price_usd REAL,
      entry_market_cap REAL,
      entry_liquidity REAL,
      score REAL,
      confidence REAL,
      risk_gate TEXT NOT NULL DEFAULT '',
      m15_price REAL,
      m15_return_pct REAL,
      m15_at TEXT,
      h1_price REAL,
      h1_return_pct REAL,
      h1_at TEXT,
      h6_price REAL,
      h6_return_pct REAL,
      h6_at TEXT,
      h24_price REAL,
      h24_return_pct REAL,
      h24_at TEXT,
      max_price_usd REAL,
      min_price_usd REAL,
      max_runup_pct REAL,
      max_adverse_pct REAL,
      max_drawdown_pct REAL,
      max_multiple REAL,
      first_30_at TEXT,
      first_50_at TEXT,
      first_100_at TEXT,
      first_minus30_at TEXT,
      clean_win_30 INTEGER NOT NULL DEFAULT 0,
      hit_50 INTEGER NOT NULL DEFAULT 0,
      hit_100 INTEGER NOT NULL DEFAULT 0,
      hit_minus30 INTEGER NOT NULL DEFAULT 0,
      outcome_label TEXT NOT NULL DEFAULT 'OPEN',
      status TEXT NOT NULL DEFAULT 'OPEN',
      data_quality TEXT NOT NULL DEFAULT 'PENDING',
      last_sample_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_outcome_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      token_address TEXT NOT NULL,
      sample_at TEXT NOT NULL,
      price_usd REAL,
      market_cap REAL,
      liquidity_usd REAL,
      source TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(event_key, sample_at),
      FOREIGN KEY(event_key) REFERENCES signal_outcomes(event_key)
    );

    CREATE INDEX IF NOT EXISTS idx_signal_outcomes_status ON signal_outcomes(status, triggered_at);
    CREATE INDEX IF NOT EXISTS idx_signal_outcomes_token ON signal_outcomes(token_address, triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signal_outcome_ticks_event ON signal_outcome_ticks(event_key, sample_at);
  `);
  return db;
}

function seedObservation(db, token, triggeredAt) {
  const prior = db.prepare(`
    SELECT tick_at AS at, price_usd, market_cap, liquidity_usd, source
    FROM market_ticks
    WHERE token_address=? AND price_usd>0 AND tick_at<=?
    ORDER BY tick_at DESC LIMIT 1
  `).get(token, triggeredAt);
  if (prior) return prior;
  const after = db.prepare(`
    SELECT tick_at AS at, price_usd, market_cap, liquidity_usd, source
    FROM market_ticks
    WHERE token_address=? AND price_usd>0 AND tick_at>?
    ORDER BY tick_at ASC LIMIT 1
  `).get(token, triggeredAt);
  if (after && new Date(after.at).getTime() - new Date(triggeredAt).getTime() <= 10 * 60_000) return after;
  const snap = db.prepare(`
    SELECT snapshot_at AS at, price_usd, market_cap, liquidity_usd, dex AS source
    FROM snapshots
    WHERE token_address=? AND price_usd>0
    ORDER BY ABS(strftime('%s', snapshot_at)-strftime('%s', ?)) ASC
    LIMIT 1
  `).get(token, triggeredAt);
  if (snap && Math.abs(new Date(snap.at).getTime() - new Date(triggeredAt).getTime()) <= 10 * 60_000) return snap;
  const current = db.prepare(`
    SELECT current_price_at AS at, current_price_usd AS price_usd,
           current_market_cap AS market_cap, current_liquidity_usd AS liquidity_usd,
           'tokens-current' AS source
    FROM tokens WHERE token_address=? AND current_price_usd>0
  `).get(token);
  if (current && Math.abs(new Date(current.at || triggeredAt).getTime() - new Date(triggeredAt).getTime()) <= 10 * 60_000) return current;
  return null;
}

export function syncOutcomesFromAlerts() {
  const db = ensureSignalOutcomeSchema();
  const events = db.prepare(`
    SELECT e.*
    FROM alert_events e
    LEFT JOIN signal_outcomes o ON o.event_key=e.event_key
    WHERE o.event_key IS NULL
      AND e.event_type='EARLY_ALPHA'
      AND (e.bark_status='SENT' OR e.telegram_status='SENT')
    ORDER BY e.triggered_at ASC
  `).all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO signal_outcomes (
      event_key,event_type,token_address,symbol,triggered_at,
      entry_price_usd,entry_market_cap,entry_liquidity,
      score,confidence,risk_gate,data_quality,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let added = 0;
  for (const e of events) {
    const token = text(e.token_address).toLowerCase();
    const seed = seedObservation(db, token, e.triggered_at);
    const quality = seed?.price_usd ? 'SEEDED' : 'WAITING_ENTRY';
    const info = db.prepare(`SELECT current_liquidity_usd FROM tokens WHERE token_address=?`).get(token) || {};
    const result = insert.run(
      e.event_key, e.event_type, token, text(e.symbol), e.triggered_at,
      num(seed?.price_usd), num(seed?.market_cap), num(seed?.liquidity_usd) ?? num(e.liquidity) ?? num(info.current_liquidity_usd),
      num(e.score), num(e.confidence), text(e.risk_gate), quality, new Date().toISOString(),
    );
    if (result.changes) {
      added += 1;
      if (seed?.price_usd) recordOutcomeSample({
        eventKey: e.event_key,
        tokenAddress: token,
        sampleAt: seed.at || e.triggered_at,
        priceUsd: seed.price_usd,
        marketCap: seed.market_cap,
        liquidityUsd: seed.liquidity_usd,
        source: seed.source || 'seed',
      });
    }
  }
  return added;
}

export function recordOutcomeSample({ eventKey, tokenAddress, sampleAt, priceUsd, marketCap, liquidityUsd, source = '' } = {}) {
  const db = ensureSignalOutcomeSchema();
  const price = num(priceUsd);
  if (!eventKey || !tokenAddress || price == null || price <= 0) return { ok: false, reason: 'invalid_sample' };
  const at = text(sampleAt) || new Date().toISOString();
  db.prepare(`
    INSERT INTO signal_outcome_ticks
      (event_key,token_address,sample_at,price_usd,market_cap,liquidity_usd,source,created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(event_key,sample_at) DO UPDATE SET
      price_usd=excluded.price_usd,
      market_cap=COALESCE(excluded.market_cap, signal_outcome_ticks.market_cap),
      liquidity_usd=COALESCE(excluded.liquidity_usd, signal_outcome_ticks.liquidity_usd),
      source=CASE WHEN excluded.source<>'' THEN excluded.source ELSE signal_outcome_ticks.source END
  `).run(eventKey, tokenAddress.toLowerCase(), at, price, num(marketCap), num(liquidityUsd), text(source), at);
  db.prepare(`
    UPDATE signal_outcomes
    SET entry_price_usd=COALESCE(entry_price_usd,?),
        entry_market_cap=COALESCE(entry_market_cap,?),
        entry_liquidity=COALESCE(entry_liquidity,?),
        data_quality=CASE WHEN entry_price_usd IS NULL THEN 'LIVE_ENTRY' ELSE data_quality END,
        last_sample_at=?, updated_at=?
    WHERE event_key=?
  `).run(price, num(marketCap), num(liquidityUsd), at, new Date().toISOString(), eventKey);
  return { ok: true };
}

function nearestSample(samples, targetMs, toleranceMs) {
  let best = null;
  let diff = Infinity;
  for (const s of samples) {
    const d = Math.abs(new Date(s.sample_at).getTime() - targetMs);
    if (d < diff) { diff = d; best = s; }
  }
  return best && diff <= toleranceMs ? best : null;
}

function firstThreshold(samples, entry, threshold, direction = 'up') {
  for (const s of samples) {
    const r = pct(s.price_usd, entry);
    if (r == null) continue;
    if (direction === 'up' ? r >= threshold : r <= threshold) return s.sample_at;
  }
  return null;
}

function outcomeLabel(metrics, complete) {
  if (!complete) return 'OPEN';
  const mfe = num(metrics.maxRunup) ?? 0;
  const mae = num(metrics.maxAdverse) ?? 0;
  if (mfe >= 100) return 'MULTIBAGGER';
  if (metrics.cleanWin30 && mfe >= 50) return 'VALID_ALPHA';
  if (mae <= -30 && mfe < 30) return 'FALSE_BREAKOUT';
  if (mfe >= 30) return 'VALID_WEAK';
  return 'NO_EDGE';
}

export function recomputeOutcome(eventKey, now = new Date()) {
  const db = ensureSignalOutcomeSchema();
  const row = db.prepare('SELECT * FROM signal_outcomes WHERE event_key=?').get(eventKey);
  if (!row) return null;
  const entry = num(row.entry_price_usd);
  if (entry == null || entry <= 0) return row;
  const samples = db.prepare(`
    SELECT sample_at,price_usd,market_cap,liquidity_usd
    FROM signal_outcome_ticks
    WHERE event_key=? AND price_usd>0
    ORDER BY sample_at ASC
  `).all(eventKey);
  if (!samples.length) return row;

  let maxPrice = entry;
  let minPrice = entry;
  let peak = entry;
  let maxDrawdown = 0;
  for (const s of samples) {
    const p = num(s.price_usd);
    if (p == null) continue;
    maxPrice = Math.max(maxPrice, p);
    minPrice = Math.min(minPrice, p);
    peak = Math.max(peak, p);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((p / peak) - 1) * 100);
  }
  const maxRunup = pct(maxPrice, entry);
  const maxAdverse = pct(minPrice, entry);
  const triggeredMs = new Date(row.triggered_at).getTime();
  const elapsed = now.getTime() - triggeredMs;
  const values = {};
  for (const m of MILESTONES) {
    const target = triggeredMs + m.ms;
    const sample = elapsed >= m.ms ? nearestSample(samples, target, m.toleranceMs) : null;
    values[`${m.key}_price`] = sample ? num(sample.price_usd) : row[`${m.key}_price`];
    values[`${m.key}_return_pct`] = sample ? pct(sample.price_usd, entry) : row[`${m.key}_return_pct`];
    values[`${m.key}_at`] = sample ? sample.sample_at : row[`${m.key}_at`];
  }
  const first30 = row.first_30_at || firstThreshold(samples, entry, 30, 'up');
  const first50 = row.first_50_at || firstThreshold(samples, entry, 50, 'up');
  const first100 = row.first_100_at || firstThreshold(samples, entry, 100, 'up');
  const firstMinus30 = row.first_minus30_at || firstThreshold(samples, entry, -30, 'down');
  const cleanWin30 = Boolean(first30 && (!firstMinus30 || first30 < firstMinus30));
  const complete = elapsed >= 24 * 60 * 60_000 && Boolean(values.h24_at);
  const metrics = { maxRunup, maxAdverse, cleanWin30 };
  const label = outcomeLabel(metrics, complete);
  const quality = samples.length >= 8 ? 'GOOD' : (samples.length >= 3 ? 'PARTIAL' : 'THIN');
  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE signal_outcomes SET
      m15_price=@m15_price,m15_return_pct=@m15_return_pct,m15_at=@m15_at,
      h1_price=@h1_price,h1_return_pct=@h1_return_pct,h1_at=@h1_at,
      h6_price=@h6_price,h6_return_pct=@h6_return_pct,h6_at=@h6_at,
      h24_price=@h24_price,h24_return_pct=@h24_return_pct,h24_at=@h24_at,
      max_price_usd=@max_price_usd,min_price_usd=@min_price_usd,
      max_runup_pct=@max_runup_pct,max_adverse_pct=@max_adverse_pct,
      max_drawdown_pct=@max_drawdown_pct,max_multiple=@max_multiple,
      first_30_at=@first_30_at,first_50_at=@first_50_at,first_100_at=@first_100_at,first_minus30_at=@first_minus30_at,
      clean_win_30=@clean_win_30,hit_50=@hit_50,hit_100=@hit_100,hit_minus30=@hit_minus30,
      outcome_label=@outcome_label,status=@status,data_quality=@data_quality,
      completed_at=@completed_at,updated_at=@updated_at
    WHERE event_key=@event_key
  `).run({
    event_key: eventKey,
    ...values,
    max_price_usd: maxPrice,
    min_price_usd: minPrice,
    max_runup_pct: maxRunup,
    max_adverse_pct: maxAdverse,
    max_drawdown_pct: maxDrawdown,
    max_multiple: maxPrice / entry,
    first_30_at: first30,
    first_50_at: first50,
    first_100_at: first100,
    first_minus30_at: firstMinus30,
    clean_win_30: cleanWin30 ? 1 : 0,
    hit_50: first50 ? 1 : 0,
    hit_100: first100 ? 1 : 0,
    hit_minus30: firstMinus30 ? 1 : 0,
    outcome_label: label,
    status: complete ? 'COMPLETE' : 'OPEN',
    data_quality: quality,
    completed_at: complete ? (row.completed_at || updatedAt) : null,
    updated_at: updatedAt,
  });
  return db.prepare('SELECT * FROM signal_outcomes WHERE event_key=?').get(eventKey);
}

export function recomputeOpenOutcomes(now = new Date()) {
  const db = ensureSignalOutcomeSchema();
  const rows = db.prepare(`SELECT event_key FROM signal_outcomes WHERE status='OPEN' ORDER BY triggered_at ASC`).all();
  return rows.map(r => recomputeOutcome(r.event_key, now)).filter(Boolean);
}

export function getOpenOutcomes(limit = 20) {
  const db = ensureSignalOutcomeSchema();
  return db.prepare(`
    SELECT o.*,t.decimals,t.total_supply,t.first_pool_key
    FROM signal_outcomes o
    LEFT JOIN tokens t ON t.token_address=o.token_address
    WHERE o.status='OPEN'
    ORDER BY o.triggered_at ASC
    LIMIT ?
  `).all(limit);
}

export function getOutcomeRows(limit = 500) {
  const db = ensureSignalOutcomeSchema();
  return db.prepare(`SELECT * FROM signal_outcomes ORDER BY triggered_at DESC LIMIT ?`).all(limit);
}

function scoreBucket(v) {
  const n = num(v) ?? 0;
  if (n >= 85) return '85+';
  if (n >= 80) return '80-84';
  if (n >= 75) return '75-79';
  return '70-74';
}
function confidenceBucket(v) {
  const n = num(v) ?? 0;
  if (n >= 80) return '80+';
  if (n >= 70) return '70-79';
  return '60-69';
}
function liquidityBucket(v) {
  const n = num(v) ?? 0;
  if (n >= 100000) return '100K+';
  if (n >= 50000) return '50-100K';
  if (n >= 20000) return '20-50K';
  return '10-20K';
}

function summarizeGroup(dimension, bucket, rows) {
  const n = rows.length;
  const rate = key => n ? rows.filter(r => Number(r[key] || 0) === 1).length / n * 100 : null;
  return {
    dimension,
    bucket,
    samples: n,
    cleanWin30Rate: rate('clean_win_30'),
    hit50Rate: rate('hit_50'),
    hit100Rate: rate('hit_100'),
    fail30Rate: rate('hit_minus30'),
    median15m: median(rows.map(r => r.m15_return_pct)),
    median1h: median(rows.map(r => r.h1_return_pct)),
    median6h: median(rows.map(r => r.h6_return_pct)),
    median24h: median(rows.map(r => r.h24_return_pct)),
    medianMfe: median(rows.map(r => r.max_runup_pct)),
    medianMae: median(rows.map(r => r.max_adverse_pct)),
    medianMdd: median(rows.map(r => r.max_drawdown_pct)),
  };
}

export function getCalibrationRows() {
  const db = ensureSignalOutcomeSchema();
  const rows = db.prepare(`SELECT * FROM signal_outcomes WHERE status='COMPLETE' AND data_quality<>'THIN'`).all();
  const groups = [];
  const dimensions = [
    ['Score', scoreBucket],
    ['Confidence', confidenceBucket],
    ['Liquidity', liquidityBucket],
    ['RiskGate', r => text(r.risk_gate) || 'UNKNOWN'],
  ];
  for (const [dimension, fn] of dimensions) {
    const map = new Map();
    for (const r of rows) {
      const bucket = fn(r);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket).push(r);
    }
    for (const [bucket, items] of map) groups.push(summarizeGroup(dimension, bucket, items));
  }
  for (const cutoff of [70, 75, 80, 85]) {
    const items = rows.filter(r => Number(r.score || 0) >= cutoff);
    if (items.length) groups.push(summarizeGroup('ScoreCutoff', `>=${cutoff}`, items));
  }
  return groups;
}
