// Robinhood Chain 新币扫描 Webhook 接收器 v3-fast
// 目标：降低 Apps Script / Google Sheets 往返次数，避免 enrichment 高峰超时。
const RH_INGEST_CFG = {
  spreadsheetId: '1Z1OU8bVZb_c2RFyponEx9uJSlDAaSOMH0wLORZGJRww',
  discoverySheet: '新币发现',
  statusSheet: '扫描状态',
  secretProperty: 'INGEST_SECRET',
  rowCacheSeconds: 21600
};

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    verifySecret_(e, payload);

    const kind = String(firstDefined_(payload, [
      'kind', 'type', 'eventType', 'event_type', 'event'
    ]) || '').toLowerCase();

    if (
      kind.includes('heartbeat') ||
      kind.includes('status') ||
      payload.heartbeat ||
      payload.latestBlock != null ||
      payload.latest_block != null
    ) {
      writeScannerStatusFast_(payload);
      return jsonResponse_({ ok: true, handled: 'status', version: 'v3-fast' });
    }

    const ca = normalizeAddress_(firstDefined_(payload, [
      'tokenCa', 'tokenCA', 'token', 'tokenAddress', 'token_address',
      'address', 'ca', 'contractAddress', 'contract_address'
    ]));
    if (!ca) return jsonResponse_({ ok: false, error: 'missing_token_ca' }, 400);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let result;
    try {
      result = upsertDiscoveryFast_(payload, ca);
    } finally {
      lock.releaseLock();
    }

    return jsonResponse_({
      ok: true,
      handled: 'discovery',
      row: result.row,
      created: result.created,
      ca: ca,
      version: 'v3-fast'
    });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: String(err && err.message ? err.message : err),
      version: 'v3-fast'
    }, 500);
  }
}

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'rh-chain-monitor-ingest-v3-fast',
    time: new Date().toISOString()
  });
}

function parsePayload_(e) {
  const raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (_) { throw new Error('invalid_json'); }
}

function verifySecret_(e, payload) {
  const expected = String(
    PropertiesService.getScriptProperties().getProperty(RH_INGEST_CFG.secretProperty) || ''
  ).trim();
  if (!expected) throw new Error('INGEST_SECRET_not_configured');

  const querySecret = e && e.parameter ? e.parameter.secret : '';
  const bodySecret = firstDefined_(payload, [
    'secret', 'ingestSecret', 'ingest_secret', 'webhookSecret'
  ]);
  const received = String(bodySecret || querySecret || '').trim();
  if (!received || received !== expected) throw new Error('unauthorized');
}

function upsertDiscoveryFast_(p, ca) {
  const ss = SpreadsheetApp.openById(RH_INGEST_CFG.spreadsheetId);
  const sh = ss.getSheetByName(RH_INGEST_CFG.discoverySheet);
  if (!sh) throw new Error('discovery_sheet_missing');

  const now = new Date();
  const existingRow = findRowByCaFast_(sh, ca);
  const created = !existingRow;
  const row = existingRow || Math.max(2, sh.getLastRow() + 1);

  const values = created
    ? new Array(30).fill('')
    : sh.getRange(row, 1, 1, 30).getValues()[0];

  const firstSeen = parseDateOrText_(firstDefined_(p, [
    'firstSeen', 'first_seen', 'seenAt', 'seen_at', 'timestamp'
  ])) || now;
  const lastUpdate = parseDateOrText_(firstDefined_(p, [
    'lastUpdate', 'last_update', 'updatedAt', 'updated_at'
  ])) || now;

  const stage = firstDefined_(p, ['stage', 'phase', 'eventType', 'event_type', 'event', 'status']);
  const source = firstDefined_(p, ['source', 'platform', 'launcher', 'factoryType', 'factory_type']);
  const symbol = firstDefined_(p, ['symbol', 'ticker', 'tokenSymbol', 'token_symbol']);
  const pool = firstDefined_(p, [
    'pool', 'poolAddress', 'pool_address', 'curve', 'curveAddress',
    'curve_address', 'poolId', 'pool_id'
  ]);
  const pairToken = firstDefined_(p, [
    'pairToken', 'pair_token', 'quoteToken', 'quote_token', 'pairedToken'
  ]);
  const pairType = firstDefined_(p, [
    'pairType', 'pair_type', 'quoteType', 'quote_type', 'pairLabel'
  ]);
  const deployer = firstDefined_(p, [
    'deployer', 'creator', 'owner', 'deployerAddress', 'deployer_address'
  ]);
  const txHash = firstDefined_(p, [
    'txHash', 'tx_hash', 'transactionHash', 'transaction_hash'
  ]);
  const block = toNumberOrBlank_(firstDefined_(p, [
    'block', 'blockNumber', 'block_number', 'latestBlock'
  ]));
  const firstTrade = parseDateOrText_(firstDefined_(p, [
    'firstTrade', 'first_trade', 'firstTradeAt', 'first_trade_at'
  ]));
  const price = toNumberOrBlank_(firstDefined_(p, ['price', 'priceUsd', 'price_usd']));
  const lp = toNumberOrBlank_(firstDefined_(p, ['lp', 'liquidity', 'liquidityUsd', 'liquidity_usd']));
  const vol1m = toNumberOrBlank_(firstDefined_(p, ['volume1m', 'volume_1m', 'm1Volume', 'm1_volume']));
  const buys1m = toNumberOrBlank_(firstDefined_(p, ['buys1m', 'buys_1m', 'm1Buys', 'm1_buys']));
  const sells1m = toNumberOrBlank_(firstDefined_(p, ['sells1m', 'sells_1m', 'm1Sells', 'm1_sells']));
  const uniqueTraders = toNumberOrBlank_(firstDefined_(p, [
    'uniqueTraders', 'unique_traders', 'traders1m', 'traders_1m', 'traderCount'
  ]));
  const holders = toNumberOrBlank_(firstDefined_(p, ['holders', 'holderCount', 'holder_count']));
  const buyUsd1h = toNumberOrBlank_(firstDefined_(p, ['buyUsd1h', 'buy_usd_1h', 'h1BuyUsd', 'h1_buy_usd']));
  const sellUsd1h = toNumberOrBlank_(firstDefined_(p, ['sellUsd1h', 'sell_usd_1h', 'h1SellUsd', 'h1_sell_usd']));
  const riskFlags = stringifyCompact_(firstDefined_(p, ['riskFlags', 'risk_flags', 'risks', 'warnings']));
  const enrichment = stringifyCompact_(firstDefined_(p, ['enrichment', 'enrichmentStatus', 'enrichment_status']));
  const notes = stringifyCompact_(firstDefined_(p, ['notes', 'note', 'meta']));

  if (!values[0]) values[0] = firstSeen;
  values[1] = lastUpdate;
  putIfPresent_(values, 2, stage);
  putIfPresent_(values, 3, source);
  putIfPresent_(values, 4, symbol);
  values[5] = ca;
  putIfPresent_(values, 6, pool);
  putIfPresent_(values, 7, pairToken);
  putIfPresent_(values, 8, pairType);
  putIfPresent_(values, 9, deployer);
  putIfPresent_(values, 10, txHash);
  putIfPresent_(values, 11, block);
  putIfPresent_(values, 12, firstTrade);
  putIfPresent_(values, 13, price);
  putIfPresent_(values, 14, lp);
  putIfPresent_(values, 15, vol1m);
  putIfPresent_(values, 16, buys1m);
  putIfPresent_(values, 17, sells1m);
  putIfPresent_(values, 19, uniqueTraders);
  putIfPresent_(values, 20, holders);
  putIfPresent_(values, 21, buyUsd1h);
  putIfPresent_(values, 22, sellUsd1h);
  putIfPresent_(values, 24, riskFlags);
  putIfPresent_(values, 25, enrichment);
  putIfPresent_(values, 29, notes);

  sh.getRange(row, 1, 1, 30).setValues([values]);
  cacheCaRow_(ca, row);

  const isEnrichment = String(enrichment || '').toLowerCase().indexOf('v2.') === 0;
  if (!isEnrichment) {
    updateOneStatusMetricFast_(ss.getSheetByName(RH_INGEST_CFG.statusSheet), {
      metric: 'Last Discovery',
      value: (symbol || ca) + '｜' + (stage || 'event'),
      status: '🟢 已接收',
      now: now,
      source: source || 'Webhook',
      note: 'CA全局去重；First Seen不覆盖',
      blocked: '否',
      next: '等待Canary自动评分'
    });
  }

  return { row: row, created: created };
}

function findRowByCaFast_(sh, ca) {
  const cache = CacheService.getScriptCache();
  const key = 'rhca:' + ca.toLowerCase();
  const hit = Number(cache.get(key));
  if (Number.isFinite(hit) && hit >= 2) return hit;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const found = sh.getRange(2, 6, lastRow - 1, 1)
    .createTextFinder(ca)
    .matchEntireCell(true)
    .matchCase(false)
    .findNext();
  const row = found ? found.getRow() : 0;
  if (row) cache.put(key, String(row), RH_INGEST_CFG.rowCacheSeconds);
  return row;
}

function cacheCaRow_(ca, row) {
  CacheService.getScriptCache().put(
    'rhca:' + ca.toLowerCase(), String(row), RH_INGEST_CFG.rowCacheSeconds
  );
}

function writeScannerStatusFast_(p) {
  const ss = SpreadsheetApp.openById(RH_INGEST_CFG.spreadsheetId);
  const sh = ss.getSheetByName(RH_INGEST_CFG.statusSheet);
  if (!sh) throw new Error('status_sheet_missing');

  const now = new Date();
  const latestBlock = firstDefined_(p, ['latestBlock', 'latest_block', 'block']);
  const provider = firstDefined_(p, ['provider', 'wsProvider', 'ws_provider', 'transport']) || 'Scanner';
  const heartbeat = firstDefined_(p, ['heartbeat', 'timestamp', 'time']) || now;
  const listeners = firstDefined_(p, ['listeners', 'listenerStatus', 'listener_status']);

  const lastRow = Math.max(2, sh.getLastRow());
  const rows = sh.getRange(2, 1, lastRow - 1, 8).getValues();
  const idx = {};
  rows.forEach(function(r, i) { if (r[0]) idx[String(r[0]).trim()] = i; });

  upsertStatusArray_(rows, idx, 'Scanner Heartbeat', [
    String(heartbeat), '🟢 正常', now, provider, '轻量心跳', '否', '持续运行'
  ]);
  if (latestBlock !== '' && latestBlock != null) {
    upsertStatusArray_(rows, idx, 'Latest Block', [
      String(latestBlock), '🟢 更新中', now, provider, '区块号持续增长才算健康', '否', '持续监听'
    ]);
  }
  if (listeners && typeof listeners === 'object') {
    Object.keys(listeners).forEach(function(k) {
      upsertStatusArray_(rows, idx, 'Listener ' + k, [
        stringifyCompact_(listeners[k]), '🟢 已上报', now, 'Scanner', '', '否', '持续监听'
      ]);
    });
  }
  upsertStatusArray_(rows, idx, 'Scanner Overall', [
    'Heartbeat已接收', '🟢 运行中', now, provider, 'Webhook链路正常', '否', '等待新币事件'
  ]);

  sh.getRange(2, 1, rows.length, 8).setValues(rows);
}

function upsertStatusArray_(rows, idx, metric, tail7) {
  let i = idx[metric];
  if (i == null) {
    i = rows.length;
    idx[metric] = i;
    rows.push(new Array(8).fill(''));
  }
  rows[i] = [metric].concat(tail7);
}

function updateOneStatusMetricFast_(sh, x) {
  if (!sh) return;
  const lastRow = Math.max(2, sh.getLastRow());
  const names = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  let row = 0;
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0] || '').trim() === x.metric) { row = i + 2; break; }
  }
  if (!row) row = lastRow + 1;
  sh.getRange(row, 1, 1, 8).setValues([[
    x.metric, x.value, x.status, x.now, x.source, x.note, x.blocked, x.next
  ]]);
}

function putIfPresent_(arr, index, value) {
  if (value !== '' && value !== null && value !== undefined) arr[index] = value;
}

function firstDefined_(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function normalizeAddress_(v) {
  const s = String(v || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s) ? s : '';
}

function parseDateOrText_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date) return v;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d;
  return String(v);
}

function toNumberOrBlank_(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(String(v).replace(/[,$%x]/g, ''));
  return Number.isFinite(n) ? n : '';
}

function stringifyCompact_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); }
  catch (_) { return String(v); }
}

function jsonResponse_(obj, statusCode) {
  const body = Object.assign({}, obj);
  if (statusCode) body.statusCode = statusCode;
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
