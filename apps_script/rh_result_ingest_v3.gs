// Robinhood Chain 新币扫描结果接收器 v3
// 只接收 SQLite 结果层批量同步，不接高频原始事件。
const RH_RESULT_SYNC = {
  spreadsheetId: '1F14qiEljakOobmv7PLxiSFRCa3wo_sX-teHosVKGvMY',
  secretProperty: 'INGEST_SECRET',
  allowedSheets: {
    '新币发现': 31,
    'Canary跟踪': 33,
    '阶段升级记录': 20
  },
  maxRowsPerSheet: 1000
};

function doGet() {
  return json_({
    ok: true,
    service: 'rh-result-ingest-v3',
    mode: 'sqlite-result-layer',
    spreadsheetId: RH_RESULT_SYNC.spreadsheetId,
    time: new Date().toISOString()
  });
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    verifySecret_(e, payload);
    const kind = String(payload.kind || '').trim();
    if (kind !== 'result_sync_v1') {
      return json_({ ok: false, error: 'unsupported_kind', kind: kind }, 400);
    }

    const ss = SpreadsheetApp.openById(RH_RESULT_SYNC.spreadsheetId);
    const sheets = payload.sheets || {};
    const result = {};

    Object.keys(RH_RESULT_SYNC.allowedSheets).forEach(function(name) {
      if (!Object.prototype.hasOwnProperty.call(sheets, name)) return;
      result[name] = replaceResultRows_(ss, name, sheets[name]);
    });

    updateSyncStatus_(ss, payload, result);
    SpreadsheetApp.flush();
    return json_({
      ok: true,
      handled: 'result_sync_v1',
      generatedAt: payload.generatedAt || '',
      result: result,
      time: new Date().toISOString()
    });
  } catch (err) {
    return json_({
      ok: false,
      error: String(err && err.message ? err.message : err)
    }, 500);
  }
}

function replaceResultRows_(ss, name, rows) {
  const width = RH_RESULT_SYNC.allowedSheets[name];
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('sheet_missing:' + name);

  const input = Array.isArray(rows) ? rows.slice(0, RH_RESULT_SYNC.maxRowsPerSheet) : [];
  const normalized = input.map(function(row) {
    const src = Array.isArray(row) ? row : [];
    const out = [];
    for (let i = 0; i < width; i++) out.push(normalizeCell_(src[i]));
    return out;
  });

  const oldRows = Math.max(0, sh.getLastRow() - 1);
  const clearRows = Math.max(oldRows, normalized.length);
  if (clearRows > 0) sh.getRange(2, 1, clearRows, width).clearContent();
  if (normalized.length > 0) sh.getRange(2, 1, normalized.length, width).setValues(normalized);

  applyFormats_(sh, name, Math.max(2, normalized.length + 1));
  return { rows: normalized.length, width: width };
}

function applyFormats_(sh, name, lastRow) {
  const n = Math.max(1, lastRow - 1);
  if (name === '新币发现') {
    sh.getRange(2, 1, n, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange(2, 11, n, 1).setNumberFormat('0.00000000');
    sh.getRange(2, 12, n, 2).setNumberFormat('$#,##0.00');
    sh.getRange(2, 23, n, 2).setNumberFormat('0.0');
  } else if (name === 'Canary跟踪') {
    sh.getRange(2, 1, n, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange(2, 5, n, 1).setNumberFormat('0.00000000');
    sh.getRange(2, 6, n, 2).setNumberFormat('$#,##0.00');
    sh.getRange(2, 8, n, 1).setNumberFormat('0.00000000');
    sh.getRange(2, 9, n, 2).setNumberFormat('$#,##0.00');
    sh.getRange(2, 11, n, 2).setNumberFormat('0.00x');
    sh.getRange(2, 26, n, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange(2, 27, n, 1).setNumberFormat('0.00000000');
    sh.getRange(2, 28, n, 2).setNumberFormat('$#,##0.00');
  } else if (name === '阶段升级记录') {
    sh.getRange(2, 1, n, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange(2, 9, n, 1).setNumberFormat('0.00000000');
    sh.getRange(2, 10, n, 2).setNumberFormat('$#,##0.00');
    sh.getRange(2, 18, n, 2).setNumberFormat('0.0');
  }
}

function updateSyncStatus_(ss, payload, result) {
  const sh = ss.getSheetByName('扫描状态');
  if (!sh) return;
  const now = new Date();
  setStatusRow_(sh, 'Sheet Sync', payload.generatedAt || now, '正常',
    'SQLite 批量结果已同步', '每5分钟');
  setStatusRow_(sh, 'Scanner Version', payload.version || '', '正常',
    'Railway 当前生产版本', '部署时');
  setStatusRow_(sh, 'Failed Jobs', numberOrZero_(payload.health && payload.health.failedJobs),
    numberOrZero_(payload.health && payload.health.failedJobs) > 0 ? '警告' : '正常',
    'jobs.status=FAILED', '每5分钟');
  setStatusRow_(sh, 'Dead Letter Open', numberOrZero_(payload.health && payload.health.deadLetterOpen),
    numberOrZero_(payload.health && payload.health.deadLetterOpen) > 0 ? '警告' : '正常',
    '待人工重跑失败任务', '每5分钟');
  setStatusRow_(sh, 'SQLite DB', payload.health && payload.health.dbPath || '/data/rh_monitor.db', '正常',
    '结果源：SQLite', '每5分钟');
}

function setStatusRow_(sh, metric, value, status, note, frequency) {
  const last = Math.max(2, sh.getLastRow());
  const vals = sh.getRange(2, 1, Math.max(1, last - 1), 1).getDisplayValues();
  let row = 0;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() === metric) { row = i + 2; break; }
  }
  if (!row) row = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(row, 1, 1, 5).setValues([[metric, normalizeCell_(value), status, note, frequency]]);
}

function normalizeCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  try { return JSON.stringify(v); } catch (err) { return String(v); }
}

function numberOrZero_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function parsePayload_(e) {
  const raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (err) { throw new Error('invalid_json'); }
}

function verifySecret_(e, payload) {
  const expected = String(PropertiesService.getScriptProperties().getProperty(RH_RESULT_SYNC.secretProperty) || '').trim();
  if (!expected) throw new Error('INGEST_SECRET_not_configured');
  const querySecret = e && e.parameter ? e.parameter.secret : '';
  const received = String(payload.secret || payload.ingestSecret || querySecret || '').trim();
  if (!received || received !== expected) throw new Error('unauthorized');
}

function json_(obj, statusCode) {
  const body = Object.assign({}, obj);
  if (statusCode) body.statusCode = statusCode;
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
