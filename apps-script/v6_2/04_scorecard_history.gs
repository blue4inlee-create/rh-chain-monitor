function maybeCaptureSignalScorecard_(ss, radar, now) {
  const sh = ss.getSheetByName(RH_DEX_CFG.scorecardSheet);
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

  const trendRanks = {
    '趋势临战': 1,
    '趋势共振待闸门': 2,
    '趋势执行候选': 3
  };
  const secondRanks = {
    '二段临战': 1,
    '二段执行候选': 2
  };

  data.forEach(function(r) {
    const symbol = String(r[2] || '').trim();
    const ca = String(r[3] || '').trim();
    const pair = String(r[8] || '').trim();
    const price = toNum_(r[9]);
    const lp = toNum_(r[10]);
    const safety = String(r[22] || '').trim();
    const score = toNum_(r[23]);
    const track = String(r[24] || '').trim();
    const trend = String(r[25] || '').trim();
    const second = String(r[26] || '').trim();
    const decisionDataStatus = String(r[67] || '').trim();
    const warmLevel = toNum_(r[RH_DEX_CFG.canonicalWarmLevelIndex]);
    const warmQuality = String(r[RH_DEX_CFG.canonicalWarmQualityIndex] || '').trim();
    const canonicalWarmOk = warmLevel >= 2 && (warmQuality === '🟢双窗共振' || warmQuality === '🔥强共振');
    const headGate = String(smartGateMap[symbol] || '').trim();

    if (!symbol || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !pair || price <= 0) return;

    const blocked = /^🔴/.test(safety) || decisionDataStatus !== '🟢 决策数据可用';
    let trendSignal = '';
    let secondSignal = '';

    if (!blocked && track === '趋势临战' && canonicalWarmOk) {
      if (trend === '🟢 量价共振') {
        trendSignal = lp >= 200000 && /^🟢/.test(headGate)
          ? '趋势执行候选'
          : '趋势共振待闸门';
      } else {
        trendSignal = '趋势临战';
      }
    }

    if (!blocked && /^🟢/.test(second)) {
      secondSignal = lp >= 200000 && /^🟢/.test(headGate)
        ? '二段执行候选'
        : '二段临战';
    }

    captureSignalChannel_(
      props,
      'RH_SCORECARD_TREND_' + ca.toLowerCase(),
      pair,
      trendSignal,
      function(signalType) { rows.push([now, symbol, ca, pair, signalType, price, score]); },
      trendRanks
    );

    captureSignalChannel_(
      props,
      'RH_SCORECARD_SECOND_' + ca.toLowerCase(),
      pair,
      secondSignal,
      function(signalType) { rows.push([now, symbol, ca, pair, signalType, price, score]); },
      secondRanks
    );
  });

  if (!rows.length) return;

  const maxRows = sh.getMaxRows();
  const aValues = sh.getRange(2, 1, Math.max(1, maxRows - 1), 1).getValues();
  let emptyIdx = aValues.findIndex(function(r) { return !r[0]; });
  let startRow = emptyIdx >= 0 ? emptyIdx + 2 : maxRows + 1;
  const neededLastRow = startRow + rows.length - 1;

  if (neededLastRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), neededLastRow - sh.getMaxRows());

  sh.getRange(startRow, 1, rows.length, 7).setValues(rows);
  sh.getRange(startRow, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(startRow, 6, rows.length, 1).setNumberFormat('0.00000000');
  sh.getRange(startRow, 7, rows.length, 1).setNumberFormat('0.0');

  if (sh.getMaxColumns() >= 16 && sh.getRange(2, 8).getFormula()) {
    sh.getRange(2, 8, 1, 9).copyTo(
      sh.getRange(startRow, 8, rows.length, 9),
      SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
      false
    );
  }

  if (sh.getMaxColumns() >= 22 && sh.getRange(2, 22).getFormula()) {
    sh.getRange(2, 22).copyTo(
      sh.getRange(startRow, 22, rows.length, 1),
      SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
      false
    );
  }
}

function captureSignalChannel_(props, key, pair, signal, onNewSignal, rankMap) {
  const previous = String(props.getProperty(key) || '');
  if (!signal) {
    if (previous) props.deleteProperty(key);
    return;
  }

  const state = pair.toLowerCase() + '||' + signal;
  if (previous === state) return;

  if (previous) {
    const cut = previous.lastIndexOf('||');
    const prevPair = cut >= 0 ? previous.substring(0, cut) : '';
    const prevSignal = cut >= 0 ? previous.substring(cut + 2) : '';
    const nowRank = (rankMap && rankMap[signal]) || 0;
    const prevRank = (rankMap && rankMap[prevSignal]) || 0;
    if (prevPair === pair.toLowerCase() && nowRank <= prevRank) {
      props.setProperty(key, state);
      return;
    }
  }

  onNewSignal(signal);
  props.setProperty(key, state);
}

function maybeAppendRadarHistory_(ss, radar, now) {
  const props = PropertiesService.getScriptProperties();
  const bucketMs = RH_DEX_CFG.radarHistoryEveryMinutes * 60 * 1000;
  const currentBucket = Math.floor(now.getTime() / bucketMs);
  const lastBucket = Number(props.getProperty('RH_LAST_RADAR_HISTORY_BUCKET') || -1);
  if (lastBucket === currentBucket) return;

  const sh = ss.getSheetByName(RH_DEX_CFG.radarHistorySheet);
  if (!sh) return;

  const lastRow = Math.min(radar.getLastRow(), 200);
  if (lastRow < 2) return;

  const src = radar.getRange(2, 1, lastRow - 1, 45).getValues();
  updateRadarLifecycle_(radar, src, props);

  const rows = src.filter(function(r) {
    return String(r[2] || '').trim() && /^0x[a-fA-F0-9]{40}$/.test(String(r[3] || '').trim());
  }).map(function(r) {
    return [
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      r[2], r[3], r[9], r[10], r[12], r[13], r[14], r[15],
      r[16], r[17], r[18], r[19], r[20], r[22], r[23], r[24], r[25], r[8]
    ];
  });

  if (!rows.length) return;

  let startRow = sh.getLastRow() + 1;
  const neededLastRow = startRow + rows.length - 1;
  if (neededLastRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), neededLastRow - sh.getMaxRows());

  sh.getRange(startRow, 1, rows.length, 19).setValues(rows);
  props.setProperty('RH_LAST_RADAR_HISTORY_TS', String(now.getTime()));
  props.setProperty('RH_LAST_RADAR_HISTORY_BUCKET', String(currentBucket));

  const overflow = sh.getLastRow() - RH_DEX_CFG.maxRadarHistoryRows;
  if (overflow > 0) sh.deleteRows(2, overflow);
}

function updateRadarLifecycle_(radar, src, props) {
  src.forEach(function(r, idx) {
    const symbol = String(r[2] || '').trim();
    const ca = String(r[3] || '').trim();
    const pair = String(r[8] || '').trim().toLowerCase();
    if (!symbol || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !pair) return;

    const safety = String(r[22] || '').trim();
    const lp = toNum_(r[10]);
    const h24Vol = toNum_(r[14]);
    const key = 'RH_LIFECYCLE_' + ca.toLowerCase();
    const saved = String(props.getProperty(key) || '');

    let prevPair = '';
    let prevCount = 0;
    if (saved) {
      const cut = saved.lastIndexOf('||');
      prevPair = cut >= 0 ? saved.substring(0, cut) : '';
      prevCount = cut >= 0 ? Number(saved.substring(cut + 2)) || 0 : 0;
    }

    let count = 0;
    let lifecycle = '活跃候选';

    if (/^🔴/.test(safety)) {
      lifecycle = '风险排除';
    } else {
      const low =
        (Number.isFinite(lp) && lp < 50000) ||
        (Number.isFinite(h24Vol) && h24Vol < 30000);
      if (low) {
        count = prevPair === pair ? Math.min(prevCount + 1, 999) : 1;
        lifecycle = count >= 3 ? '休眠' : ('低迷观察 ' + count + '/3');
      }
    }

    props.setProperty(key, pair + '||' + count);
    radar.getRange(idx + 2, 42).setValue(lifecycle);
    radar.getRange(idx + 2, 43).setValue(count);
  });
}
