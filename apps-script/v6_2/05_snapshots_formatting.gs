function maybeAppendSnapshots_(ss, rows, now) {
  if (!rows.length) return;

  const props = PropertiesService.getScriptProperties();
  const bucketMs = RH_DEX_CFG.snapshotEveryMinutes * 60 * 1000;
  const currentBucket = Math.floor(now.getTime() / bucketMs);
  const lastBucket = Number(props.getProperty('RH_LAST_SNAPSHOT_BUCKET') || -1);

  if (lastBucket === currentBucket) return;

  let sh = ss.getSheetByName(RH_DEX_CFG.snapshotSheet);
  if (!sh) sh = ss.insertSheet(RH_DEX_CFG.snapshotSheet);

  if (sh.getMaxColumns() < 23) {
    sh.insertColumnsAfter(sh.getMaxColumns(), 23 - sh.getMaxColumns());
  }

  sh.getRange(1, 1, 1, 23).setValues([[
    '时间','标的','CA','当前价格','LP Liquidity','1H成交量',
    '1H买入笔数','1H卖出笔数','1H笔数比',
    '24H成交量','主池版本','主池Pair',
    '5M成交量','5M买入笔数','5M卖出笔数','5M笔数比','5M价格变化%',
    '写入源','1H买入额','1H卖出额','1H金额比','金额流时间','金额流源'
  ]]);
  sh.setFrozenRows(1);

  const start = sh.getLastRow() + 1;
  const neededLastRow = start + rows.length - 1;
  if (neededLastRow > sh.getMaxRows()) {
    sh.insertRowsAfter(sh.getMaxRows(), neededLastRow - sh.getMaxRows());
  }

  sh.getRange(start, 1, rows.length, 23).setValues(rows);
  sh.getRange(start, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(start, 13, rows.length, 1).setNumberFormat('$#,##0');
  sh.getRange(start, 14, rows.length, 2).setNumberFormat('0');
  sh.getRange(start, 16, rows.length, 1).setNumberFormat('0.00');
  sh.getRange(start, 17, rows.length, 1).setNumberFormat('0.00%');
  sh.getRange(start, 19, rows.length, 2).setNumberFormat('$#,##0');
  sh.getRange(start, 21, rows.length, 1).setNumberFormat('0.00x');
  sh.getRange(start, 22, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  appendBucketCache_(ss, rows, currentBucket, bucketMs);

  props.setProperty('RH_LAST_SNAPSHOT_TS', String(now.getTime()));
  props.setProperty('RH_LAST_SNAPSHOT_BUCKET', String(currentBucket));

  const overflow = sh.getLastRow() - RH_DEX_CFG.maxSnapshotRows;
  if (overflow > 0) sh.deleteRows(2, overflow);
}

function appendBucketCache_(ss, rows, currentBucket, bucketMs) {
  if (!rows.length) return;

  let sh = ss.getSheetByName(RH_DEX_CFG.bucketCacheSheet);
  if (!sh) sh = ss.insertSheet(RH_DEX_CFG.bucketCacheSheet);

  if (sh.getMaxColumns() < 11) {
    sh.insertColumnsAfter(sh.getMaxColumns(), 11 - sh.getMaxColumns());
  }

  sh.getRange(1, 1, 1, 11).setValues([[
    '5分钟桶时间','标的','CA','主池Pair','当前价格','5M成交量',
    '5M买入笔数','5M卖出笔数','5M笔数比','5M价格变化%','写入源'
  ]]);
  sh.setFrozenRows(1);

  const bucketTime = new Date(currentBucket * bucketMs);
  const out = rows.map(function(r) {
    return [
      bucketTime, r[1], r[2], r[11], r[3], r[12],
      r[13], r[14], r[15], r[16], r[17]
    ];
  });

  const start = sh.getLastRow() + 1;
  const neededLastRow = start + out.length - 1;
  if (neededLastRow > sh.getMaxRows()) {
    sh.insertRowsAfter(sh.getMaxRows(), neededLastRow - sh.getMaxRows());
  }

  sh.getRange(start, 1, out.length, 11).setValues(out);
  sh.getRange(start, 1, out.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(start, 5, out.length, 1).setNumberFormat('0.00000000');
  sh.getRange(start, 6, out.length, 1).setNumberFormat('$#,##0');
  sh.getRange(start, 7, out.length, 2).setNumberFormat('0');
  sh.getRange(start, 9, out.length, 1).setNumberFormat('0.00');
  sh.getRange(start, 10, out.length, 1).setNumberFormat('0.00%');

  const overflow = sh.getLastRow() - RH_DEX_CFG.maxBucketCacheRows;
  if (overflow > 0) sh.deleteRows(2, overflow);
}

function formatHomeColumns_(home) {
  const lastRow = Math.min(home.getLastRow(), 20);
  if (lastRow < 2) return;

  home.getRange(2, 10, lastRow - 1, 1).setNumberFormat('0.00000000');
  home.getRange(2, 13, lastRow - 1, 2).setNumberFormat('$#,##0');
  home.getRange(2, 15, lastRow - 1, 1).setNumberFormat('0.00x');
  home.getRange(2, 18, lastRow - 1, 1).setNumberFormat('0.00');
  home.getRange(2, 27, lastRow - 1, 1).setNumberFormat('$#,##0');
  home.getRange(2, 36, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  home.getRange(2, 43, lastRow - 1, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

function formatRadarColumns_(radar) {
  const lastRow = Math.min(radar.getLastRow(), 200);
  if (lastRow < 2) return;

  radar.getRange(2, 10, lastRow - 1, 1).setNumberFormat('0.00000000');
  radar.getRange(2, 11, lastRow - 1, 1).setNumberFormat('$#,##0');
  radar.getRange(2, 13, lastRow - 1, 1).setNumberFormat('$#,##0');
  radar.getRange(2, 14, lastRow - 1, 1).setNumberFormat('0.00x');
  radar.getRange(2, 15, lastRow - 1, 1).setNumberFormat('$#,##0');
  radar.getRange(2, 16, lastRow - 1, 1).setNumberFormat('0.00x');
  radar.getRange(2, 19, lastRow - 1, 1).setNumberFormat('0.00');
  radar.getRange(2, 30, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  radar.getRange(2, 45, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  if (radar.getMaxColumns() >= 49) {
    radar.getRange(2, 36, lastRow - 1, 3).setNumberFormat('0.0%');
    radar.getRange(2, 46, lastRow - 1, 1).setNumberFormat('$#,##0');
    radar.getRange(2, 47, lastRow - 1, 1).setNumberFormat('0');
    radar.getRange(2, 48, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  if (radar.getMaxColumns() >= 73) {
    radar.getRange(2, 72, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

function auditDexTriggers() {
  const ss = SpreadsheetApp.openById(RH_DEX_CFG.spreadsheetId);
  writeRefreshAudit_(ss, new Date());
}
