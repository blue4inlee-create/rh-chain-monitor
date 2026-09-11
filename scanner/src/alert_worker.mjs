import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';
import { ensureOpportunitySchema } from './opportunity_repository.mjs';

const CFG = {
  pollMs: Math.max(5_000, Number(process.env.ALERT_POLL_MS || 15_000)),
  confirmations: Math.max(1, Number(process.env.ALERT_CONFIRMATIONS || 2)),
  cooldownMs: Math.max(60_000, Number(process.env.ALERT_COOLDOWN_MS || 30 * 60_000)),
  instantScore: Number(process.env.ALERT_INSTANT_SCORE || 85),
  minScore: Number(process.env.ALERT_MIN_SCORE || 70),
  minConfidence: Number(process.env.ALERT_MIN_CONFIDENCE || 60),
  minLiquidity: Number(process.env.ALERT_MIN_LIQUIDITY || 10_000),
  maxRiskPenalty: Number(process.env.ALERT_MAX_RISK_PENALTY || 8),
  requireAllChannels: String(process.env.ALERT_REQUIRE_ALL_CHANNELS || 'true').toLowerCase() !== 'false',
  barkServer: String(process.env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, ''),
  barkKey: String(process.env.BARK_DEVICE_KEY || '').trim(),
  telegramToken: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
};

let stopping = false;

function text(v) { return v == null ? '' : String(v).trim(); }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseJson(v, fallback = {}) {
  if (!v) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nowIso() { return new Date().toISOString(); }
function money(v) {
  const n = num(v);
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function evaluateEarlyAlpha(row = {}) {
  const payload = parseJson(row.payload, {});
  const stage = text(row.stage).toUpperCase();
  const classification = text(row.classification).toLowerCase();
  const score = num(row.score) ?? 0;
  const confidence = num(row.score_confidence) ?? num(row.confidence) ?? 0;
  const liquidity = num(row.liquidity) ?? 0;
  const riskGate = text(row.risk_gate || payload.riskGate || 'CAUTION').toUpperCase();
  const hardFailCount = num(row.hard_fail_count) ?? num(payload.hardFailCount) ?? 0;
  const buyBlocked = Number(row.buy_blocked ?? payload.buyBlocked ?? 0) === 1 || payload.buyBlocked === true;
  const riskPenalty = num(payload.riskPenalty ?? payload.risk_penalty ?? payload?.scoreBreakdown?.riskPenalty);
  const riskFlags = Array.isArray(payload.riskFlags) ? payload.riskFlags.map(text).filter(Boolean) : [];
  const riskReasons = Array.isArray(payload.riskReasons)
    ? payload.riskReasons.map(text).filter(Boolean)
    : parseJson(row.risk_reasons, []);
  const riskText = [...riskFlags, ...(Array.isArray(riskReasons) ? riskReasons : [])].join(' | ');
  const hardFlag = /honeypot|blacklist|mint[_ -]?risk|lp[_ -]?risk|rug|cannot[_ -]?sell|sell[_ -]?(block|fail)/i.test(riskText);

  const eligible =
    stage === 'CANARY' &&
    (classification === 'early_alpha' || classification === 'confirm_watch') &&
    score >= CFG.minScore &&
    confidence >= CFG.minConfidence &&
    liquidity >= CFG.minLiquidity &&
    riskGate !== 'BLOCK' &&
    !buyBlocked &&
    hardFailCount === 0 &&
    !hardFlag &&
    (riskPenalty == null || riskPenalty <= CFG.maxRiskPenalty);

  const instant = eligible &&
    score >= CFG.instantScore &&
    confidence >= 75 &&
    liquidity >= 20_000 &&
    riskGate === 'CLEAR';

  return {
    eligible,
    instant,
    stage,
    classification,
    score,
    confidence,
    liquidity,
    riskGate,
    hardFailCount,
    buyBlocked,
    riskPenalty,
    riskFlags,
    riskReasons: Array.isArray(riskReasons) ? riskReasons : [],
  };
}

function ensureAlertSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_signal_state (
      token_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      last_observation_at TEXT,
      cycle_started_at TEXT,
      last_sent_at TEXT,
      last_score REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (token_address, event_type)
    );

    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      token_address TEXT NOT NULL,
      symbol TEXT DEFAULT '',
      score REAL,
      confidence REAL,
      liquidity REAL,
      risk_gate TEXT DEFAULT '',
      risk_summary TEXT DEFAULT '',
      cycle_started_at TEXT,
      triggered_at TEXT NOT NULL,
      bark_status TEXT DEFAULT 'PENDING',
      telegram_status TEXT DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT DEFAULT '',
      payload TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_alert_events_token ON alert_events(token_address, triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_state_active ON alert_signal_state(event_type, active, notified);
  `);
}

function channelState() {
  const bark = Boolean(CFG.barkKey);
  const telegram = Boolean(CFG.telegramToken && CFG.telegramChatId);
  const ready = CFG.requireAllChannels ? (bark && telegram) : (bark || telegram);
  return { bark, telegram, ready };
}

function formatMessage(row, evalResult) {
  const symbol = text(row.symbol) || 'UNKNOWN';
  const address = text(row.token_address);
  const reasons = evalResult.riskReasons.length
    ? evalResult.riskReasons.slice(0, 3).join('; ')
    : (evalResult.riskFlags.length ? evalResult.riskFlags.slice(0, 3).join('; ') : '无硬风险命中');
  return {
    title: `🚨 RH Early Alpha｜${symbol}`,
    body: [
      `Score ${evalResult.score.toFixed(0)}｜Confidence ${evalResult.confidence.toFixed(0)}`,
      `LP ${money(evalResult.liquidity)}｜Risk ${evalResult.riskGate}`,
      `CA ${address}`,
      `风险：${reasons}`,
      '动作：小仓候选，深核后执行',
      '候选不是买入指令。',
    ].join('\n'),
  };
}

async function sendBark(title, body) {
  const url = `${CFG.barkServer}/${encodeURIComponent(CFG.barkKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'rh-chain-alert/1.0' },
    body: JSON.stringify({ title, body, group: 'RH Chain', level: 'timeSensitive' }),
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await res.text();
  if (!res.ok) throw new Error(`bark_${res.status}:${responseText.slice(0, 160)}`);
  return true;
}

async function sendTelegram(title, body) {
  const url = `https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'rh-chain-alert/1.0' },
    body: JSON.stringify({
      chat_id: CFG.telegramChatId,
      text: `${title}\n${body}`,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await res.text();
  if (!res.ok) throw new Error(`telegram_${res.status}:${responseText.slice(0, 160)}`);
  let parsed = null;
  try { parsed = JSON.parse(responseText); } catch {}
  if (parsed && parsed.ok === false) throw new Error(`telegram_api:${text(parsed.description).slice(0, 160)}`);
  return true;
}

function getState(db, address) {
  return db.prepare(`SELECT * FROM alert_signal_state WHERE token_address=? AND event_type='EARLY_ALPHA'`).get(address);
}

function upsertState(db, row) {
  db.prepare(`
    INSERT INTO alert_signal_state
      (token_address,event_type,active,hit_count,notified,last_observation_at,cycle_started_at,last_sent_at,last_score,updated_at)
    VALUES (@token_address,'EARLY_ALPHA',@active,@hit_count,@notified,@last_observation_at,@cycle_started_at,@last_sent_at,@last_score,@updated_at)
    ON CONFLICT(token_address,event_type) DO UPDATE SET
      active=excluded.active,
      hit_count=excluded.hit_count,
      notified=excluded.notified,
      last_observation_at=excluded.last_observation_at,
      cycle_started_at=excluded.cycle_started_at,
      last_sent_at=excluded.last_sent_at,
      last_score=excluded.last_score,
      updated_at=excluded.updated_at
  `).run(row);
}

function eventRow(db, eventKey) {
  return db.prepare('SELECT * FROM alert_events WHERE event_key=?').get(eventKey);
}

function writeEvent(db, data) {
  db.prepare(`
    INSERT INTO alert_events
      (event_key,event_type,token_address,symbol,score,confidence,liquidity,risk_gate,risk_summary,
       cycle_started_at,triggered_at,bark_status,telegram_status,attempts,last_error,payload)
    VALUES (@event_key,'EARLY_ALPHA',@token_address,@symbol,@score,@confidence,@liquidity,@risk_gate,@risk_summary,
            @cycle_started_at,@triggered_at,@bark_status,@telegram_status,@attempts,@last_error,@payload)
    ON CONFLICT(event_key) DO UPDATE SET
      score=excluded.score,
      confidence=excluded.confidence,
      liquidity=excluded.liquidity,
      risk_gate=excluded.risk_gate,
      risk_summary=excluded.risk_summary,
      triggered_at=excluded.triggered_at,
      bark_status=excluded.bark_status,
      telegram_status=excluded.telegram_status,
      attempts=excluded.attempts,
      last_error=excluded.last_error,
      payload=excluded.payload
  `).run(data);
}

async function dispatch(db, row, evalResult, state) {
  const channels = channelState();
  if (!channels.ready) return { complete: false, skipped: 'channels_not_ready' };

  const cycleStarted = state.cycle_started_at || nowIso();
  const eventKey = `${row.token_address}|EARLY_ALPHA|${cycleStarted}`;
  const previous = eventRow(db, eventKey) || {};
  const { title, body } = formatMessage(row, evalResult);
  let barkStatus = previous.bark_status || (channels.bark ? 'PENDING' : 'DISABLED');
  let telegramStatus = previous.telegram_status || (channels.telegram ? 'PENDING' : 'DISABLED');
  const errors = [];

  if (channels.bark && barkStatus !== 'SENT') {
    try { await sendBark(title, body); barkStatus = 'SENT'; }
    catch (err) { barkStatus = 'FAILED'; errors.push(text(err?.message || err)); }
  }
  if (channels.telegram && telegramStatus !== 'SENT') {
    try { await sendTelegram(title, body); telegramStatus = 'SENT'; }
    catch (err) { telegramStatus = 'FAILED'; errors.push(text(err?.message || err)); }
  }

  const complete = CFG.requireAllChannels
    ? (!channels.bark || barkStatus === 'SENT') && (!channels.telegram || telegramStatus === 'SENT') && channels.bark && channels.telegram
    : (barkStatus === 'SENT' || telegramStatus === 'SENT');

  writeEvent(db, {
    event_key: eventKey,
    token_address: row.token_address,
    symbol: text(row.symbol),
    score: evalResult.score,
    confidence: evalResult.confidence,
    liquidity: evalResult.liquidity,
    risk_gate: evalResult.riskGate,
    risk_summary: [...evalResult.riskReasons, ...evalResult.riskFlags].slice(0, 8).join(' | '),
    cycle_started_at: cycleStarted,
    triggered_at: nowIso(),
    bark_status: barkStatus,
    telegram_status: telegramStatus,
    attempts: Number(previous.attempts || 0) + 1,
    last_error: errors.join(' | ').slice(0, 500),
    payload: JSON.stringify({ title, body, classification: evalResult.classification, instant: evalResult.instant }),
  });

  return { complete, barkStatus, telegramStatus, errors };
}

function cooldownPassed(state) {
  if (!state?.last_sent_at) return true;
  const last = new Date(state.last_sent_at).getTime();
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= CFG.cooldownMs;
}

async function processCandidate(db, row) {
  const address = text(row.token_address).toLowerCase();
  if (!address) return null;
  const evaluation = evaluateEarlyAlpha(row);
  const existing = getState(db, address);
  const observationAt = text(row.updated_at) || nowIso();

  if (!evaluation.eligible) {
    if (existing?.active) {
      upsertState(db, {
        token_address: address,
        active: 0,
        hit_count: 0,
        notified: 0,
        last_observation_at: observationAt,
        cycle_started_at: null,
        last_sent_at: existing.last_sent_at || null,
        last_score: evaluation.score,
        updated_at: nowIso(),
      });
    }
    return null;
  }

  let state = existing;
  if (!state || !state.active) {
    state = {
      token_address: address,
      active: 1,
      hit_count: 1,
      notified: 0,
      last_observation_at: observationAt,
      cycle_started_at: nowIso(),
      last_sent_at: state?.last_sent_at || null,
      last_score: evaluation.score,
      updated_at: nowIso(),
    };
    upsertState(db, state);
  } else if (text(state.last_observation_at) !== observationAt) {
    state = {
      ...state,
      token_address: address,
      active: 1,
      hit_count: Number(state.hit_count || 0) + 1,
      last_observation_at: observationAt,
      last_score: evaluation.score,
      updated_at: nowIso(),
    };
    upsertState(db, state);
  }

  const ready = evaluation.instant || Number(state.hit_count || 0) >= CFG.confirmations;
  if (!ready || Number(state.notified || 0) === 1 || !cooldownPassed(state)) return null;

  const dispatchResult = await dispatch(db, { ...row, token_address: address }, evaluation, state);
  if (dispatchResult.complete) {
    state = { ...state, notified: 1, last_sent_at: nowIso(), updated_at: nowIso() };
    upsertState(db, state);
    console.log('[alert sent]', JSON.stringify({
      symbol: row.symbol,
      address,
      score: evaluation.score,
      confidence: evaluation.confidence,
      bark: dispatchResult.barkStatus,
      telegram: dispatchResult.telegramStatus,
    }));
  } else if (!dispatchResult.skipped) {
    console.error('[alert partial]', JSON.stringify({
      symbol: row.symbol,
      address,
      bark: dispatchResult.barkStatus,
      telegram: dispatchResult.telegramStatus,
      errors: dispatchResult.errors,
    }));
  }
  return dispatchResult;
}

export async function runAlertCycle() {
  initializeDatabase();
  ensureOpportunitySchema();
  const db = getDatabase();
  ensureAlertSchema(db);
  const rows = db.prepare(`
    SELECT * FROM opportunity_pool
    ORDER BY updated_at DESC, score DESC
    LIMIT 1000
  `).all();
  for (const row of rows) await processCandidate(db, row);
  return { rows: rows.length, channels: channelState() };
}

async function main() {
  initializeDatabase();
  ensureOpportunitySchema();
  ensureAlertSchema(getDatabase());
  const channels = channelState();
  console.log('[alert worker boot]', JSON.stringify({
    pollMs: CFG.pollMs,
    confirmations: CFG.confirmations,
    cooldownMs: CFG.cooldownMs,
    requireAllChannels: CFG.requireAllChannels,
    barkConfigured: channels.bark,
    telegramConfigured: channels.telegram,
  }));

  while (!stopping) {
    try { await runAlertCycle(); }
    catch (err) { console.error('[alert worker]', text(err?.stack || err?.message || err)); }
    await sleep(CFG.pollMs);
  }
}

function shutdown() {
  stopping = true;
  try { closeDatabase(); } catch {}
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[alert worker fatal]', err?.stack || err);
    process.exitCode = 1;
  });
}
