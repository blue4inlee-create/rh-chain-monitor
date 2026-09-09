function refreshHomeToken_(home, token, allPairs, now, amountFlowMap) {
  const main = pickMainUniPair_(allPairs, token.ca);

  if (!main) {
    home.getRange(token.row, 42)
      .setValue('🔴 未找到Robinhood Uni V3/V4合格主池');
    return;
  }

  const price = toNum_(main.priceUsd);
  const lp = toNum_(main.liquidity && main.liquidity.usd);
  const h1Vol = toNum_(main.volume && main.volume.h1);
  const h24Vol = toNum_(main.volume && main.volume.h24);
  const buys = toNum_(main.txns && main.txns.h1 && main.txns.h1.buys);
  const sells = toNum_(main.txns && main.txns.h1 && main.txns.h1.sells);
  const txnRatio = sells > 0 ? buys / sells : (buys > 0 ? 999 : 0);
  const version = getUniVersion_(main);
  const pairId = String(main.pairAddress || '');
  const amountFlow = getAmountFlowForPair_(amountFlowMap, token.ca, pairId);

  const pairChanged =
    token.previousPair &&
    token.previousPair.toLowerCase() !== pairId.toLowerCase();

  const migrationWasPending =
    token.previousPoolNote.indexOf('🟡 主池迁移待复核') === 0;

  const migrationReviewed =
    token.previousPoolNote.indexOf('✅ 主池迁移已复核') === 0;

  const migrationLocked =
    pairChanged || (migrationWasPending && !migrationReviewed);

  if (Number.isFinite(price)) home.getRange(token.row, 10).setValue(price);
  if (Number.isFinite(lp)) home.getRange(token.row, 13).setValue(lp);
  if (Number.isFinite(h1Vol)) home.getRange(token.row, 14).setValue(h1Vol);
  if (amountFlow && isAmountFlowFresh_(amountFlow, now)) {
    home.getRange(token.row, 15).setValue(amountFlow.ratio);
    home.getRange(token.row, 44).setValue(new Date(amountFlow.ts));
  }

  home.getRange(token.row, 16).setValue(buys);
  home.getRange(token.row, 17).setValue(sells);
  home.getRange(token.row, 18).setValue(txnRatio);

  if (Number.isFinite(h24Vol)) {
    home.getRange(token.row, 27).setValue(h24Vol);
  }

  home.getRange(token.row, 36).setValue(now);
  home.getRange(token.row, 39).setValue(version);
  home.getRange(token.row, 40).setValue(pairId);
  home.getRange(token.row, 43).setValue(now);

  if (migrationLocked) {
    home.getRange(token.row, 42).setValue('🟡 主池迁移待复核');
    home.getRange(token.row, 12).setValue('○ 主池迁移待复核');

    if (pairChanged) {
      home.getRange(token.row, 41).setValue(
        '🟡 主池迁移待复核｜新主池 ' +
        version +
        '｜Pair ' +
        pairId +
        '｜深扫确认同池ATH/基准后，把本格改为“✅ 主池迁移已复核”解除锁'
      );
    }
  } else {
    home.getRange(token.row, 42).setValue('🟢 正常');

    home.getRange(token.row, 41).setValue(
      'API每5分钟批量刷新：首页+热度雷达共用请求；只取Robinhood ' +
      version +
      ' 最大Liquidity主池；失败保留上次成功数据'
    );

    const ath = home.getRange(token.row, 11).getValue();

    if (Number.isFinite(price) && typeof ath === 'number' && ath > 0) {
      const dd = (price - ath) / ath;
      const arrow = dd > 0 ? '▲ ' : dd < 0 ? '▼ ' : '— ';
      home.getRange(token.row, 12)
        .setValue(arrow + (dd * 100).toFixed(2) + '%');
    }
  }
}

function refreshRadarToken_(radar, token, allPairs, now, homePoolStateMap, amountFlowMap) {
  const main = pickMainUniPair_(allPairs, token.ca);

  if (!main) {
    radar.getRange(token.row, 44)
      .setValue('🔴 未找到Robinhood Uni V3/V4合格主池');
    return;
  }

  const price = toNum_(main.priceUsd);
  const lp = toNum_(main.liquidity && main.liquidity.usd);
  const h1Vol = toNum_(main.volume && main.volume.h1);
  const h24Vol = toNum_(main.volume && main.volume.h24);
  const buys = toNum_(main.txns && main.txns.h1 && main.txns.h1.buys);
  const sells = toNum_(main.txns && main.txns.h1 && main.txns.h1.sells);
  const txnRatio = sells > 0 ? buys / sells : (buys > 0 ? 999 : 0);
  const h1Multiplier = h24Vol > 0 ? h1Vol / (h24Vol / 24) : 0;
  const version = getUniVersion_(main);
  const pairId = String(main.pairAddress || '');
  const amountFlow = getAmountFlowForPair_(amountFlowMap, token.ca, pairId);

  const pairChanged =
    token.previousPair &&
    token.previousPair.toLowerCase() !== pairId.toLowerCase();

  const migrationWasPending =
    token.previousApiStatus.indexOf('🟡 主池迁移待复核') === 0 ||
    token.previousApiStatus.indexOf('🟡 首页主池迁移待同步') === 0;

  const migrationReviewed =
    token.previousApiStatus.indexOf('✅ 主池迁移已复核') === 0;

  const migrationLocked =
    pairChanged || (migrationWasPending && !migrationReviewed);

  if (amountFlow && isAmountFlowFresh_(amountFlow, now)) {
    radar.getRange(token.row, 16).setValue(amountFlow.ratio);
    radar.getRange(token.row, 72).setValue(new Date(amountFlow.ts));
    radar.getRange(token.row, 73).setValue(amountFlow.source);
  }

  if (token.homeStatus === '已在首页') {
    const homeState =
      (homePoolStateMap && homePoolStateMap[token.ca.toLowerCase()]) || null;

    if (homeState) {
      const homeMigrationPending =
        homeState.poolNote.indexOf('🟡 主池迁移待复核') === 0 ||
        homeState.apiStatus.indexOf('🟡 主池迁移待复核') === 0 ||
        (homeState.pair && homeState.pair.toLowerCase() !== pairId.toLowerCase());

      if (homeMigrationPending) {
        radar.getRange(token.row, 44).setValue('🟡 首页主池迁移待同步');
      } else if (/^🟢/.test(homeState.apiStatus)) {
        radar.getRange(token.row, 44).setValue('🟢 首页API同步');
      } else {
        radar.getRange(token.row, 44).setValue(
          homeState.apiStatus || '🟡 首页状态待同步'
        );
      }
    } else {
      radar.getRange(token.row, 44).setValue(
        migrationLocked ? '🟡 首页主池迁移待同步' : '🟡 首页状态待同步'
      );
    }
    radar.getRange(token.row, 45).setValue(now);
    return;
  }

  let lpChangeText = '新建5分钟基线';

  if (token.previousLp > 0 && Number.isFinite(lp)) {
    const lpChg = (lp - token.previousLp) / token.previousLp;
    const arrow = lpChg > 0 ? '▲ ' : lpChg < 0 ? '▼ ' : '— ';
    lpChangeText = arrow + (lpChg * 100).toFixed(2) + '% / 5m';
  }

  if (migrationLocked) {
    lpChangeText = '🟡 主池迁移｜5分钟基线重建';
  }

  radar.getRange(token.row, 8).setValue(version);
  radar.getRange(token.row, 9).setValue(pairId);
  if (Number.isFinite(price)) radar.getRange(token.row, 10).setValue(price);
  if (Number.isFinite(lp)) radar.getRange(token.row, 11).setValue(lp);
  radar.getRange(token.row, 12).setValue(lpChangeText);
  if (Number.isFinite(h1Vol)) radar.getRange(token.row, 13).setValue(h1Vol);
  radar.getRange(token.row, 14).setValue(h1Multiplier);
  if (Number.isFinite(h24Vol)) radar.getRange(token.row, 15).setValue(h24Vol);

  radar.getRange(token.row, 17).setValue(buys);
  radar.getRange(token.row, 18).setValue(sells);
  radar.getRange(token.row, 19).setValue(txnRatio);

  radar.getRange(token.row, 30).setValue(now);
  radar.getRange(token.row, 44).setValue(
    migrationLocked ? '🟡 主池迁移待复核' : '🟢 正常'
  );
  radar.getRange(token.row, 45).setValue(now);
}

function markHomeFailure_(home, tokens, status) {
  tokens.forEach(function(token) {
    home.getRange(token.row, 42).setValue(status);
  });
}

function markRadarFailure_(radar, tokens, status) {
  tokens.forEach(function(token) {
    radar.getRange(token.row, 44).setValue(status);
  });
}

function pickMainUniPair_(pairs, tokenCa) {
  if (!Array.isArray(pairs)) return null;

  const ca = tokenCa.toLowerCase();

  const eligible = pairs.filter(function(p) {
    const chainOk =
      String(p.chainId || '').toLowerCase() === RH_DEX_CFG.chainId;

    const dexOk =
      String(p.dexId || '').toLowerCase().includes('uniswap');

    const labels = (p.labels || []).map(function(x) {
      return String(x).toLowerCase();
    });

    const versionOk =
      labels.includes('v3') || labels.includes('v4');

    const base = String(
      (p.baseToken && p.baseToken.address) || ''
    ).toLowerCase();

    return chainOk && dexOk && versionOk && base === ca;
  });

  eligible.sort(function(a, b) {
    return (
      toNum_(b.liquidity && b.liquidity.usd) -
      toNum_(a.liquidity && a.liquidity.usd)
    );
  });

  return eligible[0] || null;
}

function getUniVersion_(pair) {
  const labels = (pair.labels || []).map(function(x) {
    return String(x).toLowerCase();
  });

  if (labels.includes('v4')) return 'Uni V4';
  if (labels.includes('v3')) return 'Uni V3';
  return 'Uni';
}
