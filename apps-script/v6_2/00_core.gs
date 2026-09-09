// V6.2: V6.1全量M5 + DexPaprika 15分钟1H金额流旁路 + 资金方向确认
const RH_DEX_CFG = {
  scriptVersion: 'V6.2-flow-r3-flowlink',
  spreadsheetId: '1Z1OU8bVZb_c2RFyponEx9uJSlDAaSOMH0wLORZGJRww',
  homeSheet: '首页机会排序',
  radarSheet: '热度雷达',
  snapshotSheet: 'API分钟快照',
  bucketCacheSheet: 'M5桶缓存',
  scorecardSheet: '信号成绩单',
  reminderSheet: '提醒记录',
  smartMoneySheet: '聪明钱追踪',
  radarHistorySheet: '热度雷达历史',
  settingsSheet: 'API自动刷新',
  deepQueueSheet: '执行深核队列',
  radarHistoryEveryMinutes: 60,
  maxRadarHistoryRows: 3000,
  chainId: 'robinhood',
  refreshEveryMinutes: 5,
  snapshotEveryMinutes: 5,
  snapshotSourceTag: 'V6.1_FULL_M5',
  amountFlowEveryMinutes: 15,
  amountFlowMaxAgeMinutes: 30,
  amountFlowMaxTokens: 14,
  amountFlowSourceTag: 'V6.2_DEXPAPRIKA_1H',
  paprikaBaseUrl: 'https://api.dexpaprika.com',
  maxSnapshotRows: 50000,
  maxBucketCacheRows: 10000,
  maxBatchTokens: 30,
  radarReadColumns: 71,
  canonicalWarmLevelIndex: 69,
  canonicalWarmQualityIndex: 70
};
function installDexRefresh() {
  removeDexRefreshTriggers_();
  ScriptApp.newTrigger('refreshDexScreenerLive')
    .timeBased()
    .everyMinutes(RH_DEX_CFG.refreshEveryMinutes)
    .create();
  const ss = SpreadsheetApp.openById(RH_DEX_CFG.spreadsheetId);
  const radar = ss.getSheetByName(RH_DEX_CFG.radarSheet);
  if (radar) ensureV62RadarSchema_(radar);
  ensureV62DecisionFormula_(ss);
  refreshDexScreenerLive();
  auditDexTriggers();
}

function uninstallDexRefresh() {
  removeDexRefreshTriggers_();
}

function removeDexRefreshTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) {
      return t.getHandlerFunction() === 'refreshDexScreenerLive';
    })
    .forEach(function(t) {
      ScriptApp.deleteTrigger(t);
    });
}

function refreshDexScreenerLive() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    const ss = SpreadsheetApp.openById(RH_DEX_CFG.spreadsheetId);
    const home = ss.getSheetByName(RH_DEX_CFG.homeSheet);
    const radar = ss.getSheetByName(RH_DEX_CFG.radarSheet);
  const bucketCache = ss.getSheetByName(RH_DEX_CFG.bucketCacheSheet);

    if (!home) throw new Error('找不到首页机会排序');
    if (!radar) throw new Error('找不到热度雷达');
    ensureV62RadarSchema_(radar);

    const homeTokens = readHomeTokens_(home);
    const radarTokens = readRadarTokens_(radar);

    const uniqueMap = {};
    homeTokens.concat(radarTokens).forEach(function(t) {
      const key = t.ca.toLowerCase();
      if (!uniqueMap[key]) {
        uniqueMap[key] = { ca: t.ca, symbol: t.symbol };
      }
    });

    const uniqueTokens = Object.keys(uniqueMap).map(function(k) {
      return uniqueMap[k];
    });

    if (!uniqueTokens.length) return;

    if (uniqueTokens.length > RH_DEX_CFG.maxBatchTokens) {
      const msg = '🟡 监控CA超过30个｜需拆批；保留上次成功数据';
      markHomeFailure_(home, homeTokens, msg);
      markRadarFailure_(radar, radarTokens, msg);
      SpreadsheetApp.flush();
      return;
    }

    const now = new Date();
    const apiResult = fetchDexPairs_(uniqueTokens);
    const pairMap = apiResult.ok
      ? buildCurrentPairMap_(uniqueTokens, apiResult.pairs)
      : buildKnownPairMap_(homeTokens, radarTokens);
    const amountFlowMap = maybeRefreshAmountFlows_(uniqueTokens, pairMap, now);

    if (!apiResult.ok) {
      applyAmountFlowsWithoutDex_(home, radar, homeTokens, radarTokens, amountFlowMap, now);
      markHomeFailure_(home, homeTokens, apiResult.status);
      markRadarFailure_(radar, radarTokens, apiResult.status);
      SpreadsheetApp.flush();
      writeRefreshAudit_(ss, now);
      SpreadsheetApp.flush();
      return;
    }

    const allPairs = apiResult.pairs;
    const liveSnapshots = [];

    homeTokens.forEach(function(token) {
      refreshHomeToken_(home, token, allPairs, now, amountFlowMap);
    });

    const homePoolStateMap = readHomePoolStateMap_(home);

    radarTokens.forEach(function(token) {
      refreshRadarToken_(radar, token, allPairs, now, homePoolStateMap, amountFlowMap);
    });

    uniqueTokens.forEach(function(token) {
      const main = pickMainUniPair_(allPairs, token.ca);
      if (!main) return;

      const price = toNum_(main.priceUsd);
      const lp = toNum_(main.liquidity && main.liquidity.usd);
      const h1Vol = toNum_(main.volume && main.volume.h1);
      const h24Vol = toNum_(main.volume && main.volume.h24);
      const buys = toNum_(main.txns && main.txns.h1 && main.txns.h1.buys);
      const sells = toNum_(main.txns && main.txns.h1 && main.txns.h1.sells);
      const txnRatio = sells > 0 ? buys / sells : (buys > 0 ? 999 : 0);
      const m5Vol = toNum_(main.volume && main.volume.m5);
      const m5Buys = toNum_(main.txns && main.txns.m5 && main.txns.m5.buys);
      const m5Sells = toNum_(main.txns && main.txns.m5 && main.txns.m5.sells);
      const m5TxnRatio = m5Sells > 0 ? m5Buys / m5Sells : (m5Buys > 0 ? 999 : 0);
      const m5PriceChange = toNum_(main.priceChange && main.priceChange.m5) / 100;
      const version = getUniVersion_(main);
      const pairId = String(main.pairAddress || '');

      const flow = getAmountFlowForPair_(amountFlowMap, token.ca, pairId);
      liveSnapshots.push([
        now, token.symbol, token.ca, price, lp, h1Vol,
        buys, sells, txnRatio, h24Vol, version, pairId,
        m5Vol, m5Buys, m5Sells, m5TxnRatio, m5PriceChange,
        RH_DEX_CFG.snapshotSourceTag,
        flow ? flow.buyUsd : '',
        flow ? flow.sellUsd : '',
        flow ? flow.ratio : '',
        flow ? new Date(flow.ts) : '',
        flow ? flow.source : ''
      ]);
    });

    formatHomeColumns_(home);
    formatRadarColumns_(radar);
    maybeAppendSnapshots_(ss, liveSnapshots, now);
    SpreadsheetApp.flush();
    writeRefreshAudit_(ss, now);
    maybeAppendDecisionAlerts_(ss, radar, now);
    maybeCaptureSignalScorecard_(ss, radar, now);
    maybeAppendRadarHistory_(ss, radar, now);
    SpreadsheetApp.flush();

  } finally {
    lock.releaseLock();
  }
}

function ensureV62RadarSchema_(radar) {
  if (radar.getMaxColumns() < 73) {
    radar.insertColumnsAfter(radar.getMaxColumns(), 73 - radar.getMaxColumns());
  }
  radar.getRange(1, 72, 1, 2).setValues([['金额流时间','金额流源']]);
}

function ensureV62DecisionFormula_(ss) {
  const sh = ss.getSheetByName(RH_DEX_CFG.deepQueueSheet);
  if (!sh) return;
  const formula = '=IF(B2="","",IF(IFERROR(INDEX(\'热度雷达\'!$BU$2:$BU$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0)),"")<>"V6.2_DEXPAPRIKA_1H","🟡 等待V6.2金额流",IF(OR(IFERROR(INDEX(\'热度雷达\'!$BT$2:$BT$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0)),0)=0,NOW()-INDEX(\'热度雷达\'!$BT$2:$BT$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))>TIME(0,30,0)),"🟡 金额流陈旧",IF(AND(INDEX(\'热度雷达\'!$P$2:$P$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))>1.2,INDEX(\'热度雷达\'!$Q$2:$Q$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))>INDEX(\'热度雷达\'!$R$2:$R$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))),"🟢 买方共振｜自动",IF(AND(INDEX(\'热度雷达\'!$P$2:$P$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))>=1,INDEX(\'热度雷达\'!$Q$2:$Q$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))>INDEX(\'热度雷达\'!$R$2:$R$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))),"🟡 买方偏强｜自动",IF(INDEX(\'热度雷达\'!$P$2:$P$200,MATCH(B2,\'热度雷达\'!$C$2:$C$200,0))>1.2,"🟡 金额强｜笔数未过门｜自动","○ 买方未确认｜自动"))))))';
  const src = sh.getRange(2, 15);
  src.setFormula(formula);
  src.copyTo(sh.getRange(2, 15, 19, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
}

function readHomeTokens_(home) {
  const lastRow = Math.min(home.getLastRow(), 20);
  if (lastRow < 2) return [];

  const rows = home.getRange(2, 1, lastRow - 1, 47).getValues();

  return rows.map(function(r, idx) {
    return {
      row: idx + 2,
      symbol: String(r[8] || '').trim(),
      ca: String(r[37] || '').trim(),
      previousPair: String(r[39] || '').trim(),
      previousPoolNote: String(r[40] || '').trim()
    };
  }).filter(function(x) {
    return x.symbol && /^0x[a-fA-F0-9]{40}$/.test(x.ca);
  });
}

function readRadarTokens_(radar) {
  const lastRow = Math.min(radar.getLastRow(), 200);
  if (lastRow < 2) return [];

  const rows = radar.getRange(2, 1, lastRow - 1, 49).getValues();

  return rows.map(function(r, idx) {
    return {
      row: idx + 2,
      symbol: String(r[2] || '').trim(),
      ca: String(r[3] || '').trim(),
      previousPair: String(r[8] || '').trim(),
      previousLp: toNum_(r[10]),
      homeStatus: String(r[27] || '').trim(),
      previousApiStatus: String(r[43] || '').trim()
    };
  }).filter(function(x) {
    return x.symbol && /^0x[a-fA-F0-9]{40}$/.test(x.ca);
  });
}

function readHomePoolStateMap_(home) {
  const lastRow = Math.min(home.getLastRow(), 20);
  const map = {};
  if (lastRow < 2) return map;

  const rows = home.getRange(2, 38, lastRow - 1, 5).getValues();

  rows.forEach(function(r) {
    const ca = String(r[0] || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) return;

    map[ca.toLowerCase()] = {
      pair: String(r[2] || '').trim(),
      poolNote: String(r[3] || '').trim(),
      apiStatus: String(r[4] || '').trim()
    };
  });

  return map;
}
