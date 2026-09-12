import { readFile } from 'node:fs/promises';
import { initializeDatabase, getDatabase, closeDatabase } from './db.mjs';
import { summarizeOpportunityRisk } from './opportunity_risk_gate.mjs';

const CFG = {
  pollMs: Math.max(15_000, Number(process.env.SECOND_LEG_POLL_MS || 30_000)),
  confirmations: Math.max(1, Number(process.env.SECOND_LEG_CONFIRMATIONS || 2)),
  cooldownMs: Math.max(5 * 60_000, Number(process.env.SECOND_LEG_COOLDOWN_MS || 30 * 60_000)),
  minScore: Number(process.env.SECOND_LEG_MIN_SCORE || 70),
  minConfidence: Number(process.env.SECOND_LEG_MIN_CONFIDENCE || 70),
  minLiquidity: Number(process.env.SECOND_LEG_MIN_LIQUIDITY || 200_000),
  minVolumeH1: Number(process.env.SECOND_LEG_MIN_VOLUME_H1 || 20_000),
  minAmountRatio: Number(process.env.SECOND_LEG_MIN_AMOUNT_RATIO || 1.2),
  minHeat: Number(process.env.SECOND_LEG_MIN_HEAT || 7),
  instantScore: Number(process.env.SECOND_LEG_INSTANT_SCORE || 85),
  chain: String(process.env.DEXSCREENER_CHAIN_ID || 'robinhood'),
  paprikaBase: String(process.env.DEXPAPRIKA_BASE_URL || 'https://api.dexpaprika.com').replace(/\/+$/, ''),
  watchlistPath: String(process.env.SECOND_LEG_WATCHLIST || new URL('../config/second_leg_watchlist.json', import.meta.url).pathname),
  barkServer: String(process.env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, ''),
  barkKey: String(process.env.BARK_DEVICE_KEY || '').trim(),
  telegramToken: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
};

let stopping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = v => v == null ? '' : String(v).trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nowIso = () => new Date().toISOString();
const validAddress = v => /^0x[a-fA-F0-9]{40}$/.test(text(v));

async function loadWatchlist() {
  const rows = JSON.parse(await readFile(CFG.watchlistPath, 'utf8'));
  return (Array.isArray(rows) ? rows : []).filter(x => validAddress(x?.address) && x?.enabled !== false).map(x => ({
    ...x,
    address: text(x.address).toLowerCase(),
    preferredPair: text(x.preferredPair).toLowerCase(),
    fallbackRiskGate: text(x.fallbackRiskGate || 'CAUTION').toUpperCase(),
    athPriceUsd: num(x.athPriceUsd),
  }));
}

async function fetchJson(url, timeoutMs = 10_000) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'rh-second-leg-alert/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, status: r.status, data: await r.json() };
  } catch (e) { return { ok: false, status: 0, error: text(e?.message || e), data: null }; }
}

function eligibleUniPair(p, address) {
  const chainOk = text(p?.chainId).toLowerCase() === CFG.chain.toLowerCase();
  const dexOk = text(p?.dexId).toLowerCase().includes('uniswap');
  const labels = (Array.isArray(p?.labels) ? p.labels : []).map(x => text(x).toLowerCase());
  const versionOk = labels.includes('v3') || labels.includes('v4');
  const base = text(p?.baseToken?.address).toLowerCase();
  return chainOk && dexOk && versionOk && base === address;
}

async function marketSnapshot(item) {
  const dex = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${CFG.chain}/${item.address}`);
  if (!dex.ok || !Array.isArray(dex.data)) return { ok: false, reason: `dex_${dex.status || 0}` };
  const pairs = dex.data.filter(p => eligibleUniPair(p, item.address));
  pairs.sort((a,b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
  const pair = pairs[0];
  if (!pair) return { ok: false, reason: 'no_uni_v3_v4_pair' };
  const pairId = text(pair.pairAddress).toLowerCase();
  const tx = pair?.txns?.h1 || {};
  const buys = num(tx.buys) ?? 0;
  const sells = num(tx.sells) ?? 0;
  const h1Vol = num(pair?.volume?.h1) ?? 0;
  const h24Vol = num(pair?.volume?.h24) ?? 0;
  const txnRatio = sells > 0 ? buys / sells : (buys > 0 ? 999 : 0);
  const h1Multiplier = h24Vol > 0 ? h1Vol / (h24Vol / 24) : 0;
  const paprika = await fetchJson(`${CFG.paprikaBase}/networks/robinhood/pools/${encodeURIComponent(pairId)}`);
  const ph1 = paprika.ok ? paprika.data?.['1h'] : null;
  const buyUsd = num(ph1?.buy_usd);
  const sellUsd = num(ph1?.sell_usd);
  const flowVolume = num(ph1?.volume_usd);
  let amountRatio = null;
  let flowValid = buyUsd != null && sellUsd != null && (buyUsd > 0 || sellUsd > 0);
  if (flowValid && flowVolume != null && flowVolume > 0) {
    flowValid = Math.abs((buyUsd + sellUsd) - flowVolume) / flowVolume <= 0.15;
  }
  if (flowValid) amountRatio = sellUsd > 0 ? buyUsd / sellUsd : (buyUsd > 0 ? 999 : 0);
  return {
    ok: true,
    pairId,
    price: num(pair?.priceUsd),
    liquidity: num(pair?.liquidity?.usd) ?? 0,
    volumeH1: h1Vol,
    volumeH24: h24Vol,
    buys,
    sells,
    txnRatio,
    amountRatio,
    buyUsd,
    sellUsd,
    h1Multiplier,
    priceChangeH1: num(pair?.priceChange?.h1) ?? 0,
    priceChangeM5: num(pair?.priceChange?.m5) ?? 0,
    dexStatus: dex.status,
    flowStatus: paprika.status,
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function riskGate(db, item, liquidity) {
  const fallback = ['CLEAR','CAUTION','BLOCK'].includes(item.fallbackRiskGate) ? item.fallbackRiskGate : 'CAUTION';
  if (!tableExists(db, 'risk_checks')) return { riskGate: fallback, source: 'watchlist', reasons: [] };
  const checks = db.prepare(`
    SELECT token_address, check_name, status, severity, value, details, source, checked_at
    FROM (
      SELECT r.*, ROW_NUMBER() OVER (PARTITION BY check_name ORDER BY checked_at DESC, id DESC) rn
      FROM risk_checks r WHERE lower(token_address)=?
    ) WHERE rn=1
  `).all(item.address);
  if (!checks.length) return { riskGate: fallback, source: 'watchlist', reasons: [] };
  const s = summarizeOpportunityRisk({ checks, liquidity });
  if (s.riskGate === 'BLOCK' || fallback === 'BLOCK') return { riskGate: 'BLOCK', source: 'db+watchlist', reasons: s.riskReasons || [] };
  if (s.riskGate === 'CLEAR') return { riskGate: 'CLEAR', source: 'db', reasons: s.riskReasons || [] };
  return { riskGate: fallback, source: fallback === 'CLEAR' ? 'manual-deep-check' : 'db+watchlist', reasons: s.riskReasons || [] };
}

function positionScore(drawdown) {
  if (drawdown == null) return 0;
  if (drawdown <= -0.95) return 0;
  if (drawdown <= -0.85) return 4;
  if (drawdown <= -0.80) return 12;
  if (drawdown <= -0.70) return 25;
  if (drawdown <= -0.60) return 16;
  if (drawdown <= -0.50) return 8;
  return 2;
}
function liquidityScore(lp) {
  if (lp < 50_000) return 0;
  if (lp < 100_000) return 4;
  if (lp < 200_000) return 10;
  if (lp < 500_000) return 16;
  return 20;
}
function flowScore(m) {
  let s = m.volumeH1 >= 50_000 ? 6 : m.volumeH1 >= 20_000 ? 5 : m.volumeH1 >= 10_000 ? 3 : m.volumeH1 >= 1_000 ? 1 : 0;
  s += m.amountRatio == null ? 0 : m.amountRatio >= 1.5 ? 10 : m.amountRatio >= 1.2 ? 8 : m.amountRatio >= 1.05 ? 4 : 0;
  s += m.txnRatio >= 1.2 ? 5 : m.txnRatio >= 1 ? 3 : 0;
  if (m.buys > m.sells) s += 4;
  return clamp(s, 0, 25);
}
function heatScore(m) {
  let s = m.h1Multiplier >= 2 ? 6 : m.h1Multiplier >= 1.5 ? 5 : m.h1Multiplier >= 1.2 ? 4 : m.h1Multiplier >= 1 ? 2 : 0;
  s += m.priceChangeH1 >= 10 ? 4 : m.priceChangeH1 >= 5 ? 3 : m.priceChangeH1 > 0 ? 2 : 0;
  s += m.priceChangeM5 >= 3 ? 3 : m.priceChangeM5 > 0 ? 2 : m.priceChangeM5 <= -2 ? -4 : 0;
  s += m.txnRatio >= 1.5 ? 2 : m.txnRatio >= 1.2 ? 1 : 0;
  return clamp(s, 0, 15);
}

export function evaluateSecondLeg(item, market, risk = { riskGate:'CAUTION' }) {
  const ath = num(item?.athPriceUsd);
  const price = num(market?.price);
  const drawdown = ath && price ? price / ath - 1 : null;
  const pairMigration = Boolean(item?.preferredPair && market?.pairId && text(item.preferredPair).toLowerCase() !== text(market.pairId).toLowerCase());
  const pScore = positionScore(drawdown);
  const lScore = liquidityScore(num(market?.liquidity) ?? 0);
  const fScore = flowScore(market || {});
  const hScore = heatScore(market || {});
  const safeScore = risk.riskGate === 'CLEAR' ? 15 : 0;
  const score = pScore + lScore + fScore + hScore + safeScore;
  let confidence = 40;
  if (ath) confidence += 10;
  if (market?.pairId) confidence += 10;
  if ((num(market?.volumeH1) ?? 0) >= 0) confidence += 10;
  if (market?.amountRatio != null) confidence += 15;
  if (market?.txnRatio != null) confidence += 10;
  if (risk.riskGate === 'CLEAR') confidence += 15;
  else if (risk.riskGate === 'CAUTION') confidence += 5;
  if (pairMigration) confidence -= 30;
  confidence = clamp(confidence, 0, 100);
  const eligible = Boolean(
    market?.ok && ath && price && !pairMigration &&
    drawdown >= -0.85 && drawdown <= -0.55 &&
    market.liquidity >= CFG.minLiquidity &&
    market.volumeH1 >= CFG.minVolumeH1 &&
    market.amountRatio != null && market.amountRatio >= CFG.minAmountRatio &&
    market.buys > market.sells && market.txnRatio >= 1 &&
    hScore >= CFG.minHeat && risk.riskGate === 'CLEAR' &&
    score >= CFG.minScore && confidence >= CFG.minConfidence
  );
  return { eligible, instant: eligible && score >= CFG.instantScore && confidence >= 85, score, confidence, drawdown, positionScore:pScore, liquidityScore:lScore, flowScore:fScore, heatScore:hScore, safetyScore:safeScore, pairMigration, riskGate:risk.riskGate };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS second_leg_live (
      token_address TEXT PRIMARY KEY, symbol TEXT, pair_id TEXT, observed_at TEXT NOT NULL,
      price REAL, ath_price REAL, drawdown REAL, liquidity REAL, volume_h1 REAL,
      amount_ratio REAL, buys INTEGER, sells INTEGER, txn_ratio REAL, h1_multiplier REAL,
      price_change_h1 REAL, price_change_m5 REAL, heat_score REAL, score REAL, confidence REAL,
      risk_gate TEXT, stage TEXT, reason TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS second_leg_signal_state (
      token_address TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, hit_count INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0, cycle_started_at TEXT, last_sent_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS second_leg_alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, token_address TEXT NOT NULL,
      symbol TEXT, triggered_at TEXT NOT NULL, score REAL, confidence REAL, drawdown REAL, liquidity REAL,
      volume_h1 REAL, amount_ratio REAL, buys INTEGER, sells INTEGER, risk_gate TEXT,
      bark_status TEXT DEFAULT 'PENDING', telegram_status TEXT DEFAULT 'PENDING', last_error TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_second_leg_events_at ON second_leg_alert_events(triggered_at DESC);
  `);
}

function money(v) { const n=num(v); if(n==null)return '—'; if(n>=1e6)return `$${(n/1e6).toFixed(2)}M`; if(n>=1e3)return `$${(n/1e3).toFixed(1)}K`; return `$${n.toFixed(0)}`; }
async function sendBark(title, body) {
  if (!CFG.barkKey) return { ok:false, error:'bark_not_configured' };
  try { const r=await fetch(`${CFG.barkServer}/${encodeURIComponent(CFG.barkKey)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,body,group:'RH Chain 二段',level:'timeSensitive'}),signal:AbortSignal.timeout(10000)}); return {ok:r.ok,status:r.status,error:r.ok?'':`HTTP ${r.status}`}; }
  catch(e){return {ok:false,error:text(e?.message||e)};}
}
async function sendTelegram(title, body) {
  if (!CFG.telegramToken || !CFG.telegramChatId) return { ok:false, error:'telegram_not_configured' };
  try { const r=await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CFG.telegramChatId,text:`${title}\n${body}`,disable_web_page_preview:true}),signal:AbortSignal.timeout(10000)}); return {ok:r.ok,status:r.status,error:r.ok?'':`HTTP ${r.status}`}; }
  catch(e){return {ok:false,error:text(e?.message||e)};}
}
async function notify(title, body) { const [bark,telegram]=await Promise.all([sendBark(title,body),sendTelegram(title,body)]); return {bark,telegram,complete:bark.ok&&telegram.ok}; }

function upsertLive(db, item, market, ev, risk) {
  const stage = ev.eligible ? '二段启动' : ev.pairMigration ? '主池迁移锁' : ev.riskGate === 'BLOCK' ? '风险排除' : ev.drawdown == null ? '待建历史' : '观察';
  db.prepare(`INSERT INTO second_leg_live(token_address,symbol,pair_id,observed_at,price,ath_price,drawdown,liquidity,volume_h1,amount_ratio,buys,sells,txn_ratio,h1_multiplier,price_change_h1,price_change_m5,heat_score,score,confidence,risk_gate,stage,reason)
    VALUES(@token_address,@symbol,@pair_id,@observed_at,@price,@ath_price,@drawdown,@liquidity,@volume_h1,@amount_ratio,@buys,@sells,@txn_ratio,@h1_multiplier,@price_change_h1,@price_change_m5,@heat_score,@score,@confidence,@risk_gate,@stage,@reason)
    ON CONFLICT(token_address) DO UPDATE SET symbol=excluded.symbol,pair_id=excluded.pair_id,observed_at=excluded.observed_at,price=excluded.price,ath_price=excluded.ath_price,drawdown=excluded.drawdown,liquidity=excluded.liquidity,volume_h1=excluded.volume_h1,amount_ratio=excluded.amount_ratio,buys=excluded.buys,sells=excluded.sells,txn_ratio=excluded.txn_ratio,h1_multiplier=excluded.h1_multiplier,price_change_h1=excluded.price_change_h1,price_change_m5=excluded.price_change_m5,heat_score=excluded.heat_score,score=excluded.score,confidence=excluded.confidence,risk_gate=excluded.risk_gate,stage=excluded.stage,reason=excluded.reason`).run({
      token_address:item.address,symbol:item.symbol||'',pair_id:market.pairId||'',observed_at:nowIso(),price:market.price??null,ath_price:item.athPriceUsd??null,drawdown:ev.drawdown,liquidity:market.liquidity??null,volume_h1:market.volumeH1??null,amount_ratio:market.amountRatio,buys:market.buys??null,sells:market.sells??null,txn_ratio:market.txnRatio??null,h1_multiplier:market.h1Multiplier??null,price_change_h1:market.priceChangeH1??null,price_change_m5:market.priceChangeM5??null,heat_score:ev.heatScore,score:ev.score,confidence:ev.confidence,risk_gate:risk.riskGate,stage,reason:market.reason||''
    });
}

async function processItem(db, item) {
  const market = await marketSnapshot(item);
  if (!market.ok) {
    const ev = evaluateSecondLeg(item, market, {riskGate:item.fallbackRiskGate});
    upsertLive(db,item,{...market,pairId:'',price:null,liquidity:0,volumeH1:0,buys:0,sells:0,txnRatio:0,h1Multiplier:0,priceChangeH1:0,priceChangeM5:0,reason:market.reason},ev,{riskGate:item.fallbackRiskGate});
    return { symbol:item.symbol, eligible:false, reason:market.reason };
  }
  const risk = riskGate(db,item,market.liquidity);
  const ev = evaluateSecondLeg(item,market,risk);
  upsertLive(db,item,market,ev,risk);
  const old = db.prepare('SELECT * FROM second_leg_signal_state WHERE token_address=?').get(item.address);
  if (!ev.eligible) {
    if (old?.active) db.prepare('UPDATE second_leg_signal_state SET active=0,hit_count=0,notified=0,cycle_started_at=NULL,updated_at=? WHERE token_address=?').run(nowIso(),item.address);
    return { symbol:item.symbol, eligible:false, score:ev.score, confidence:ev.confidence, stage:'观察' };
  }
  const cycle = old?.active ? old.cycle_started_at : nowIso();
  const hits = old?.active ? Number(old.hit_count||0)+1 : 1;
  const notified = old?.active ? Number(old.notified||0) : 0;
  const lastSentAt = old?.last_sent_at || null;
  db.prepare(`INSERT INTO second_leg_signal_state(token_address,active,hit_count,notified,cycle_started_at,last_sent_at,updated_at) VALUES(?,1,?,?,?,?,?)
    ON CONFLICT(token_address) DO UPDATE SET active=1,hit_count=excluded.hit_count,notified=excluded.notified,cycle_started_at=excluded.cycle_started_at,last_sent_at=excluded.last_sent_at,updated_at=excluded.updated_at`).run(item.address,hits,notified,cycle,lastSentAt,nowIso());
  const cooldownPassed = !lastSentAt || Date.now()-new Date(lastSentAt).getTime()>=CFG.cooldownMs;
  if (!(ev.instant || hits>=CFG.confirmations) || notified || !cooldownPassed) return {symbol:item.symbol,eligible:true,waiting:true,score:ev.score};
  const title=`🚨 RH 二段启动｜${item.symbol}`;
  const body=[`二段VPS Score ${ev.score.toFixed(0)}｜Confidence ${ev.confidence.toFixed(0)}`,`回撤 ${(ev.drawdown*100).toFixed(1)}%｜LP ${money(market.liquidity)}`,`1H量 ${money(market.volumeH1)}｜金额比 ${market.amountRatio?.toFixed(2) ?? '—'}x`,`买/卖 ${market.buys}/${market.sells}｜笔数比 ${market.txnRatio.toFixed(2)}x`,`热度 ${ev.heatScore.toFixed(0)}/15｜Risk ${risk.riskGate}`,`CA ${item.address}`,'动作：二段候选，小仓前仍需确认车头/LP最新动作。','候选不是买入指令。'].join('\n');
  const sent=await notify(title,body);
  const eventKey=`${item.address}|SECOND_LEG_START|${cycle}`;
  db.prepare(`INSERT INTO second_leg_alert_events(event_key,token_address,symbol,triggered_at,score,confidence,drawdown,liquidity,volume_h1,amount_ratio,buys,sells,risk_gate,bark_status,telegram_status,last_error)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET bark_status=excluded.bark_status,telegram_status=excluded.telegram_status,last_error=excluded.last_error`).run(eventKey,item.address,item.symbol||'',nowIso(),ev.score,ev.confidence,ev.drawdown,market.liquidity,market.volumeH1,market.amountRatio,market.buys,market.sells,risk.riskGate,sent.bark.ok?'SENT':'FAILED',sent.telegram.ok?'SENT':'FAILED',[sent.bark.error,sent.telegram.error].filter(Boolean).join(' | '));
  if(sent.complete){db.prepare('UPDATE second_leg_signal_state SET notified=1,last_sent_at=?,updated_at=? WHERE token_address=?').run(nowIso(),nowIso(),item.address);console.log('[second-leg alert sent]',JSON.stringify({symbol:item.symbol,address:item.address,score:ev.score,confidence:ev.confidence}));}
  else console.error('[second-leg alert partial]',JSON.stringify({symbol:item.symbol,bark:sent.bark,telegram:sent.telegram}));
  return {symbol:item.symbol,eligible:true,sent:sent.complete,score:ev.score};
}

export async function runSecondLegCycle() {
  initializeDatabase(); const db=getDatabase(); ensureSchema(db); const list=await loadWatchlist(); const results=[];
  for(const item of list){ try{results.push(await processItem(db,item));}catch(e){console.error('[second-leg item]',item.symbol,text(e?.stack||e)); results.push({symbol:item.symbol,error:text(e?.message||e)});} await sleep(250); }
  return {watchlist:list.length,results};
}

async function testNotify(){ const r=await notify('✅ RH 二段分钟提醒已启用','Bark + Telegram 二段启动双通道测试成功。\n正式提醒只在二段硬门槛全部通过时发送。'); console.log(JSON.stringify({bark:r.bark,telegram:r.telegram})); if(!r.complete) process.exitCode=2; }
async function main(){ initializeDatabase(); ensureSchema(getDatabase()); const list=await loadWatchlist(); console.log('[second-leg worker boot]',JSON.stringify({pollMs:CFG.pollMs,confirmations:CFG.confirmations,cooldownMs:CFG.cooldownMs,watchlist:list.length,minScore:CFG.minScore,minConfidence:CFG.minConfidence,minLiquidity:CFG.minLiquidity,minVolumeH1:CFG.minVolumeH1,minAmountRatio:CFG.minAmountRatio,minHeat:CFG.minHeat})); while(!stopping){try{const r=await runSecondLegCycle();console.log('[second-leg cycle]',JSON.stringify({watchlist:r.watchlist,eligible:r.results.filter(x=>x.eligible).length,errors:r.results.filter(x=>x.error).length}));}catch(e){console.error('[second-leg worker]',text(e?.stack||e));} await sleep(CFG.pollMs);} }
function shutdown(){stopping=true;try{closeDatabase();}catch{}}
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
if(import.meta.url===`file://${process.argv[1]}`){ if(process.argv.includes('--test-notify')) testNotify().finally(shutdown); else if(process.argv.includes('--once')) runSecondLegCycle().then(x=>console.log(JSON.stringify(x))).finally(shutdown); else main().catch(e=>{console.error('[second-leg fatal]',e?.stack||e);process.exitCode=1;}); }
