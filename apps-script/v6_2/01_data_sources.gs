function fetchDexPairs_(tokens) {
  const tokenAddresses = tokens.map(function(t) {
    return t.ca;
  }).join(',');

  const url =
    'https://api.dexscreener.com/tokens/v1/' +
    encodeURIComponent(RH_DEX_CFG.chainId) +
    '/' +
    tokenAddresses;

  let resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Accept: 'application/json' }
  });

  if (resp.getResponseCode() === 429) {
    Utilities.sleep(1800 + Math.floor(Math.random() * 1200));

    resp = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Accept: 'application/json' }
    });
  }

  const code = resp.getResponseCode();

  if (code !== 200) {
    return {
      ok: false,
      status: code === 429
        ? '🟡 429限流｜批量请求失败；保留上次成功数据'
        : '🟡 API异常 HTTP ' + code + '｜保留上次成功数据'
    };
  }

  try {
    return { ok: true, pairs: JSON.parse(resp.getContentText()) };
  } catch (e) {
    return { ok: false, status: '🟡 JSON解析异常｜保留上次成功数据' };
  }
}

function buildKnownPairMap_(homeTokens, radarTokens) {
  const map = {};
  homeTokens.concat(radarTokens).forEach(function(t) {
    const ca = String(t.ca || '').toLowerCase();
    const pair = String(t.previousPair || '').trim();
    if (ca && pair && !map[ca]) map[ca] = pair;
  });
  return map;
}

function buildCurrentPairMap_(tokens, allPairs) {
  const map = {};
  tokens.forEach(function(t) {
    const main = pickMainUniPair_(allPairs, t.ca);
    if (!main) return;
    const pair = String(main.pairAddress || '').trim();
    if (pair) map[String(t.ca || '').toLowerCase()] = pair;
  });
  return map;
}

function amountFlowPropKey_(ca) {
  return 'RH_AMOUNT_FLOW_' + String(ca || '').toLowerCase();
}

function parseAmountFlowCache_(raw) {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw);
    if (!x || !x.pair || !Number.isFinite(Number(x.ts))) return null;
    return {
      pair: String(x.pair),
      buyUsd: Number(x.buyUsd),
      sellUsd: Number(x.sellUsd),
      ratio: Number(x.ratio),
      ts: Number(x.ts),
      source: String(x.source || RH_DEX_CFG.amountFlowSourceTag)
    };
  } catch (e) {
    return null;
  }
}

function maybeRefreshAmountFlows_(tokens, pairMap, now) {
  const props = PropertiesService.getScriptProperties();
  const trackedTokens = tokens.slice(0, RH_DEX_CFG.amountFlowMaxTokens);
  props.setProperty('RH_AMOUNT_FLOW_SKIPPED', String(Math.max(0, tokens.length - trackedTokens.length)));
  const bucketMs = RH_DEX_CFG.amountFlowEveryMinutes * 60 * 1000;
  const currentBucket = Math.floor(now.getTime() / bucketMs);
  const lastBucket = Number(props.getProperty('RH_LAST_AMOUNT_FLOW_BUCKET') || -1);
  const refreshBucket = currentBucket !== lastBucket;
  const cached = {};
  const targets = [];

  trackedTokens.forEach(function(t) {
    const ca = String(t.ca || '').toLowerCase();
    const pair = String((pairMap && pairMap[ca]) || '').trim();
    if (!ca || !pair) return;
    const old = parseAmountFlowCache_(props.getProperty(amountFlowPropKey_(ca)));
    if (old && old.pair.toLowerCase() === pair.toLowerCase()) cached[ca] = old;
    if (refreshBucket || !old || old.pair.toLowerCase() !== pair.toLowerCase()) {
      targets.push({ ca: ca, pair: pair });
    }
  });

  let successCount = 0;
  let failCount = 0;
  if (targets.length) {
    const requests = targets.map(function(x) {
      return {
        url: RH_DEX_CFG.paprikaBaseUrl + '/networks/robinhood/pools/' + encodeURIComponent(x.pair),
        method: 'get',
        muteHttpExceptions: true,
        headers: { Accept: 'application/json' }
      };
    });

    let responses = [];
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      responses = [];
    }

    targets.forEach(function(x, idx) {
      const resp = responses[idx];
      if (!resp || resp.getResponseCode() !== 200) {
        failCount++;
        return;
      }
      try {
        const body = JSON.parse(resp.getContentText());
        const h1 = body && body['1h'];
        const buyUsd = Number(h1 && h1.buy_usd);
        const sellUsd = Number(h1 && h1.sell_usd);
        const volumeUsd = Number(h1 && h1.volume_usd);
        if (!Number.isFinite(buyUsd) || !Number.isFinite(sellUsd) || (buyUsd <= 0 && sellUsd <= 0)) {
          failCount++;
          return;
        }
        if (Number.isFinite(volumeUsd) && volumeUsd > 0) {
          const flowSumError = Math.abs((buyUsd + sellUsd) - volumeUsd) / volumeUsd;
          if (flowSumError > 0.15) {
            failCount++;
            return;
          }
        }
        const ratio = sellUsd > 0 ? buyUsd / sellUsd : (buyUsd > 0 ? 999 : 0);
        const flow = {
          pair: x.pair,
          buyUsd: buyUsd,
          sellUsd: sellUsd,
          ratio: ratio,
          ts: now.getTime(),
          source: RH_DEX_CFG.amountFlowSourceTag
        };
        cached[x.ca] = flow;
        props.setProperty(amountFlowPropKey_(x.ca), JSON.stringify(flow));
        successCount++;
      } catch (e) {
        failCount++;
      }
    });

    props.setProperty('RH_LAST_AMOUNT_FLOW_BUCKET', String(currentBucket));
    props.setProperty('RH_LAST_AMOUNT_FLOW_ATTEMPT_TS', String(now.getTime()));
    props.setProperty('RH_LAST_AMOUNT_FLOW_RESULT', successCount + '成功/' + failCount + '失败');
    if (successCount > 0) props.setProperty('RH_LAST_AMOUNT_FLOW_SUCCESS_TS', String(now.getTime()));
  }

  return cached;
}

function getAmountFlowForPair_(amountFlowMap, ca, pairId) {
  if (!amountFlowMap) return null;
  const flow = amountFlowMap[String(ca || '').toLowerCase()] || null;
  if (!flow) return null;
  if (String(flow.pair || '').toLowerCase() !== String(pairId || '').toLowerCase()) return null;
  return flow;
}

function isAmountFlowFresh_(flow, now) {
  if (!flow || !Number.isFinite(Number(flow.ts))) return false;
  return now.getTime() - Number(flow.ts) <= RH_DEX_CFG.amountFlowMaxAgeMinutes * 60 * 1000;
}

function applyAmountFlowsWithoutDex_(home, radar, homeTokens, radarTokens, amountFlowMap, now) {
  homeTokens.forEach(function(token) {
    const pair = String(token.previousPair || '').trim();
    const flow = getAmountFlowForPair_(amountFlowMap, token.ca, pair);
    if (!flow || !isAmountFlowFresh_(flow, now)) return;
    home.getRange(token.row, 15).setValue(flow.ratio);
    home.getRange(token.row, 44).setValue(new Date(flow.ts));
  });
  radarTokens.forEach(function(token) {
    const pair = String(token.previousPair || '').trim();
    const flow = getAmountFlowForPair_(amountFlowMap, token.ca, pair);
    if (!flow || !isAmountFlowFresh_(flow, now)) return;
    radar.getRange(token.row, 16).setValue(flow.ratio);
    radar.getRange(token.row, 72).setValue(new Date(flow.ts));
    radar.getRange(token.row, 73).setValue(flow.source);
  });
}
