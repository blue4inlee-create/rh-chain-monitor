// Robinhood Chain 新币扫描 Webhook 接收器 v2
// 目标工作簿：
const RH_INGEST_CFG = {
  spreadsheetId: '1Z1OU8bVZb_c2RFyponEx9uJSlDAaSOMH0wLORZGJRww',
  discoverySheet: '新币发现',
  statusSheet: '扫描状态',
  secretProperty: 'INGEST_SECRET'
};

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    verifySecret_(e, payload);

    const kind = String(
      firstDefined_(payload, ['kind', 'type', 'eventType', 'event_type', 'event']) || ''
    ).toLowerCase();

    if (
      kind.includes('heartbeat') ||
      kind.includes('status') ||
      payload.heartbeat ||
      payload.latestBlock != null ||
      payload.latest_block != null
    ) {
      writeScannerStatus_(payload);
      return jsonResponse_({ ok: true, handled: 'status' });
    }

    const ca = normalizeAddress_(
      firstDefined_(payload, [
        'tokenCa', 'tokenCA', 'token', 'tokenAddress', 'token_address',
        'address', 'ca', 'contractAddress', 'contract_address'
      ])
    );

    if (!ca) {
      return jsonResponse_({ ok: false, error: 'missing_token_ca' }, 400);
    }

    const result = upsertDiscovery_(payload, ca);
    return jsonResponse_({
      ok: true,
      handled: 'discovery',
      row: result.row,
      created: result.created,
      ca: ca
    });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: String(err && err.message ? err.message : err)
    }, 500);
  }
}

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'rh-newcoin-ingest-v2',
    time: new Date().toISOString()
  });
}

function parsePayload_(e) {
  const raw = e && e.postData && e.postData.contents
    ? String(e.postData.contents)
    : '';
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('invalid_json');
  }
}

function verifySecret_(e, payload) {
  const expected = String(
    PropertiesService.getScriptProperties().getProperty(
      RH_INGEST_CFG.secretProperty
    ) || ''
  ).trim();

  if (!expected) {
    throw new Error('INGEST_SECRET_not_configured');
  }

  const querySecret = e && e.parameter ? e.parameter.secret : '';
  const bodySecret = firstDefined_(payload, [
    'secret', 'ingestSecret', 'ingest_secret', 'webhookSecret'
  ]);
  const received = String(bodySecret || querySecret || '').trim();

  if (!received || received !== expected) {
    throw new Error('unauthorized');
  }
}

function upsertDiscovery_(p, ca) {
  const ss = SpreadsheetApp.openById(RH_INGEST_CFG.spreadsheetId);
  const sh = ss.getSheetByName(RH_INGEST_CFG.discoverySheet);
  if (!sh) throw new Error('discovery_sheet_missing');

  const now = new Date();
  const existingRow = findRowByCa_(sh, ca);
  const row = existingRow || Math.max(2, sh.getLastRow() + 1);
  const created = !existingRow;

  const firstSeen = parseDateOrText_(
    firstDefined_(p, ['firstSeen', 'first_seen', 'seenAt', 'seen_at', 'timestamp'])
  ) || now;

  const lastUpdate = parseDateOrText_(
    firstDefined_(p, ['lastUpdate', 'last_update', 'updatedAt', 'updated_at'])
  ) || now;

  const stage = firstDefined_(p, [
    'stage', 'phase', 'eventType', 'event_type', 'event', 'status'
  ]);
  const source = firstDefined_(p, [
    'source', 'platform', 'launcher', 'factoryType', 'factory_type'
  ]);
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
  const block = toNumberOrBlank_(
    firstDefined_(p, ['block', 'blockNumber', 'block_number', 'latestBlock'])
  );
  const firstTrade = parseDateOrText_(
    firstDefined_(p, ['firstTrade', 'first_trade', 'firstTradeAt', 'first_trade_at'])
  );
  const price = toNumberOrBlank_(
    firstDefined_(p, ['price', 'priceUsd', 'price_usd'])
  );
  const lp = toNumberOrBlank_(
    firstDefined_(p, ['lp', 'liquidity', 'liquidityUsd', 'liquidity_usd'])
  );
  const vol1m = toNumberOrBlank_(
    firstDefined_(p, ['volume1m', 'volume_1m', 'm1Volume', 'm1_volume'])
  );
  const buys1m = toNumberOrBlank_(
    firstDefined_(p, ['buys1m', 'buys_1m', 'm1Buys', 'm1_buys'])
  );
  const sells1m = toNumberOrBlank_(
    firstDefined_(p, ['sells1m', 'sells_1m', 'm1Sells', 'm1_sells'])
  );
  const uniqueTraders = toNumberOrBlank_(
    firstDefined_(p, [
      'uniqueTraders', 'unique_traders', 'traders1m', 'traders_1m', 'traderCount'
    ])
  );
  const holders = toNumberOrBlank_(
    firstDefined_(p, ['holders', 'holderCount', 'holder_count'])
  );
  const buyUsd1h = toNumberOrBlank_(
    firstDefined_(p, ['buyUsd1h', 'buy_usd_1h', 'h1BuyUsd', 'h1_buy_usd'])
  );
  const sellUsd1h = toNumberOrBlank_(
    firstDefined_(p, ['sellUsd1h', 'sell_usd_1h', 'h1SellUsd', 'h1_sell_usd'])
  );
  const riskFlags = stringifyCompact_(
    firstDefined_(p, ['riskFlags', 'risk_flags', 'risks', 'warnings'])
  );
  const enrichment = stringifyCompact_(
    firstDefined_(p, ['enrichment', 'enrichmentStatus', 'enrichment_status'])
  );
  const notes = stringifyCompact_(
    firstDefined_(p, ['notes', 'note', 'meta'])
  );

  // A:R 原始事实；S 为表内公式，不覆盖。
  const ar = [
    created ? firstSeen : sh.getRange(row, 1).getValue() || firstSeen,
    lastUpdate,
    blankSafe_(stage),
    blankSafe_(source),
    blankSafe_(symbol),
    ca,
    blankSafe_(pool),
    blankSafe_(pairToken),
    blankSafe_(pairType),
    blankSafe_(deployer),
    blankSafe_(txHash),
    block,
    firstTrade || '',
    price,
    lp,
    vol1m,
    buys1m,
    sells1m
  ];
  sh.getRange(row, 1, 1, 18).setValues([ar]);

  // T:W 原始事实；X 为表内公式，不覆盖。
  sh.getRange(row, 20, 1, 4).setValues([[
    uniqueTraders,
    holders,
    buyUsd1h,
    sellUsd1h
  ]]);

  // Y:Z 原始事实；AA:AC 为表内公式，不覆盖。
  sh.getRange(row, 25, 1, 2).setValues([[
    riskFlags,
    enrichment
  ]]);

  // AD 备注。
  sh.getRange(row, 30).setValue(notes);

  sh.getRange(row, 1, 1, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(row, 13).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(row, 14).setNumberFormat('0.00000000');
  sh.getRange(row, 15, 1, 2).setNumberFormat('$#,##0');
  sh.getRange(row, 22, 1, 2).setNumberFormat('$#,##0');

  updateStatusMetric_(
    ss.getSheetByName(RH_INGEST_CFG.statusSheet),
    'Last Discovery',
    (symbol || ca) + '｜' + (stage || 'event'),
    '🟢 已接收',
    now,
    source || 'Webhook',
    'CA全局去重；First Seen不覆盖',
    '否',
    '等待Canary自动评分'
  );

  return { row: row, created: created };
}

function writeScannerStatus_(p) {
  const ss = SpreadsheetApp.openById(RH_INGEST_CFG.spreadsheetId);
  const sh = ss.getSheetByName(RH_INGEST_CFG.statusSheet);
  if (!sh) throw new Error('status_sheet_missing');

  const now = new Date();
  const latestBlock = firstDefined_(p, ['latestBlock', 'latest_block', 'block']);
  const provider = firstDefined_(p, ['provider', 'wsProvider', 'ws_provider', 'transport']);
  const heartbeat = firstDefined_(p, ['heartbeat', 'timestamp', 'time']) || now;

  updateStatusMetric_(
    sh,
    'Scanner Heartbeat',
    String(heartbeat),
    '🟢 正常',
    now,
    provider || 'Scanner',
    '30秒级心跳',
    '否',
    '持续运行'
  );

  if (latestBlock != null && latestBlock !== '') {
    updateStatusMetric_(
      sh,
      'Latest Block',
      String(latestBlock),
      '🟢 更新中',
      now,
      provider || 'Robinhood RPC',
      '区块号持续增长才算健康',
      '否',
      '持续监听'
    );
  }

  const listeners = firstDefined_(p, ['listeners', 'listenerStatus', 'listener_status']);
  if (listeners && typeof listeners === 'object') {
    Object.keys(listeners).forEach(function(k) {
      updateStatusMetric_(
        sh,
        'Listener ' + k,
        stringifyCompact_(listeners[k]),
        '🟢 已上报',
        now,
        'Scanner',
        '',
        '否',
        '持续监听'
      );
    });
  }

  updateStatusMetric_(
    sh,
    'Scanner Overall',
    'Heartbeat已接收',
    '🟢 运行中',
    now,
    provider || 'Scanner',
    'Webhook链路正常',
    '否',
    '等待新币事件'
  );
}

function updateStatusMetric_(sh, metric, value, status, now, source, note, blocked, next) {
  if (!sh) return;

  const lastRow = Math.max(1, sh.getLastRow());
  let row = 0;

  if (lastRow >= 2) {
    const vals = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === metric) {
        row = i + 2;
        break;
      }
    }
  }

  if (!row) row = Math.max(2, sh.getLastRow() + 1);

  sh.getRange(row, 1, 1, 8).setValues([[
    metric,
    blankSafe_(value),
    blankSafe_(status),
    now,
    blankSafe_(source),
    blankSafe_(note),
    blankSafe_(blocked),
    blankSafe_(next)
  ]]);
  sh.getRange(row, 4).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

function findRowByCa_(sh, ca) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const finder = sh.getRange(2, 6, lastRow - 1, 1)
    .createTextFinder(ca)
    .matchEntireCell(true)
    .matchCase(false)
    .findNext();

  return finder ? finder.getRow() : 0;
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

function blankSafe_(v) {
  return v === undefined || v === null ? '' : v;
}

function stringifyCompact_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

function jsonResponse_(obj, statusCode) {
  // Apps Script ContentService不能直接设置HTTP状态码；statusCode放在body供调用方判断。
  const body = Object.assign({}, obj);
  if (statusCode) body.statusCode = statusCode;

  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
