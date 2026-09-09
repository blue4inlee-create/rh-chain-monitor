function maybeAppendDecisionAlerts_(ss, radar, now) {
  const sh = ss.getSheetByName(RH_DEX_CFG.reminderSheet);
  if (!sh) return;

  const lastRow = Math.min(radar.getLastRow(), 200);
  if (lastRow < 2) return;

  const data = radar.getRange(2, 1, lastRow - 1, RH_DEX_CFG.radarReadColumns).getValues();
  const props = PropertiesService.getScriptProperties();
  const rows = [];

  const smartGateMap = {};
  const smart = ss.getSheetByName(RH_DEX_CFG.smartMoneySheet);
  if (smart && smart.getLastRow() >= 2) {
    smart.getRange(2, 2, smart.getLastRow() - 1, 9).getValues().forEach(function(sr) {
      const smartSymbol = String(sr[0] || '').trim();
      const smartGate = String(sr[8] || '').trim();
      if (smartSymbol) smartGateMap[smartSymbol] = smartGate;
    });
  }

  data.forEach(function(r, idx) {
    const symbol = String(r[2] || '').trim();
    const ca = String(r[3] || '').trim();
    const pair = String(r[8] || '').trim();
    const price = toNum_(r[9]);
    const safety = String(r[22] || '').trim();
    const score = toNum_(r[23]);
    const lp = toNum_(r[10]);
    const track = String(r[24] || '').trim();
    const trend = String(r[25] || '').trim();
    const second = String(r[26] || '').trim();
    const m5PriceChange = toNum_(r[49]);
    const decisionDataStatus = String(r[67] || '').trim();
    const warmLevel = toNum_(r[RH_DEX_CFG.canonicalWarmLevelIndex]);
    const warmQuality = String(r[RH_DEX_CFG.canonicalWarmQualityIndex] || '').trim();
    const canonicalWarmOk = warmLevel >= 2 && (warmQuality === '🟢双窗共振' || warmQuality === '🔥强共振');
    const headGate = String(smartGateMap[symbol] || '').trim();

    if (!symbol || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !pair || price <= 0) return;

    const key = 'RH_DECISION_ALERT_' + ca.toLowerCase();
    const previous = String(props.getProperty(key) || '');
    const blocked = decisionDataStatus !== '🟢 决策数据可用';
    if (blocked && !/^🔴/.test(safety)) return;

    let state = '';
    let trigger = '';
    let judgment = '';

    if (/^🔴/.test(safety)) {
      state = '风险';
      trigger = '风险状态升级';
      judgment = safety;
    } else if (track === '趋势临战' && canonicalWarmOk && trend === '🟢 量价共振') {
      const finalGateOk = lp >= 200000 && /^🟢/.test(headGate);
      if (finalGateOk) {
        state = '趋势执行候选';
        trigger = '趋势执行候选';
        judgment = '评分' + score + '｜' + warmQuality + '｜LP$' + Math.round(lp).toLocaleString() + '｜' + trend + '｜' + headGate;
      } else {
        state = '趋势共振待闸门';
        trigger = '趋势共振升级';
        const blockers = [];
        if (lp < 200000) blockers.push('LP<$200K');
        if (!/^🟢/.test(headGate)) blockers.push(headGate || '车头待核验');
        judgment = '评分' + score + '｜' + warmQuality + '｜' + trend + '｜待：' + blockers.join(' / ');
      }
    } else if (track === '趋势临战' && canonicalWarmOk) {
      state = '趋势临战';
      trigger = '趋势临战';
      judgment = '评分' + score + '｜' + warmQuality + '｜' + trend;
    } else if (/^🟢/.test(second)) {
      const finalGateOk = lp >= 200000 && /^🟢/.test(headGate);
      if (finalGateOk) {
        state = '二段执行候选';
        trigger = '二段执行候选';
        judgment = second + '｜LP$' + Math.round(lp).toLocaleString() + '｜' + headGate;
      } else {
        state = '二段临战';
        trigger = '二段临战';
        const blockers = [];
        if (lp < 200000) blockers.push('LP<$200K');
        if (!/^🟢/.test(headGate)) blockers.push(headGate || '车头待核验');
        judgment = second + '｜待：' + blockers.join(' / ');
      }
    } else {
      if (previous) props.deleteProperty(key);
      return;
    }

    const stateKey = state === '风险' ? ('风险:' + safety) : state;
    const current = pair.toLowerCase() + '||' + stateKey;
    if (previous === current) return;

    let prevPair = '';
    let prevState = '';
    if (previous) {
      const cut = previous.lastIndexOf('||');
      prevPair = cut >= 0 ? previous.substring(0, cut) : '';
      prevState = cut >= 0 ? previous.substring(cut + 2) : '';
    }

    const rank = {
      '趋势临战': 1,
      '趋势共振待闸门': 2,
      '二段临战': 2,
      '趋势执行候选': 3,
      '二段执行候选': 3
    };
    const getRank = function(value) {
      if (String(value || '').indexOf('风险:') === 0 || value === '风险') return 4;
      return rank[value] || 0;
    };
    const nowRank = getRank(stateKey);
    const prevRank = getRank(prevState);

    if (previous && prevPair === pair.toLowerCase() && nowRank <= prevRank && state !== '风险') {
      props.setProperty(key, current);
      return;
    }

    if (previous && prevPair && prevPair !== pair.toLowerCase()) {
      trigger = '主池迁移｜' + trigger;
    }

    rows.push([now, symbol, trigger, price, m5PriceChange, judgment]);

    const displayState = state === '风险' ? ('风险｜' + safety) : state;
    radar.getRange(idx + 2, 39, 1, 3).setValues([[displayState, now, score]]);
    radar.getRange(idx + 2, 40).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    props.setProperty(key, current);
  });

  if (!rows.length) return;

  let startRow = sh.getLastRow() + 1;
  const neededLastRow = startRow + rows.length - 1;
  if (neededLastRow > sh.getMaxRows()) {
    sh.insertRowsAfter(sh.getMaxRows(), neededLastRow - sh.getMaxRows());
  }

  sh.getRange(startRow, 1, rows.length, 6).setValues(rows);
  sh.getRange(startRow, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(startRow, 4, rows.length, 1).setNumberFormat('0.00000000');
  sh.getRange(startRow, 5, rows.length, 1).setNumberFormat('0.00%');

  if (sh.getMaxColumns() >= 14 && sh.getRange(2, 7).getFormula()) {
    sh.getRange(2, 7, 1, 8).copyTo(
      sh.getRange(startRow, 7, rows.length, 8),
      SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
      false
    );
  }
}
