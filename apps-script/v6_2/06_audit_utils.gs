function writeRefreshAudit_(ss, now) {
  const settings = ss.getSheetByName(RH_DEX_CFG.settingsSheet);
  const snapshot = ss.getSheetByName(RH_DEX_CFG.snapshotSheet);
  const home = ss.getSheetByName(RH_DEX_CFG.homeSheet);
  const radar = ss.getSheetByName(RH_DEX_CFG.radarSheet);
  const bucketCache = ss.getSheetByName(RH_DEX_CFG.bucketCacheSheet);
  if (!settings) return;

  const triggers = ScriptApp.getProjectTriggers();
  const dexTriggers = triggers.filter(function(t) {
    return t.getHandlerFunction() === 'refreshDexScreenerLive';
  });

  const triggerStatus = dexTriggers.length === 1
    ? '🟢 当前脚本项目1个刷新触发器'
    : (dexTriggers.length === 0
      ? '🔴 当前脚本项目无刷新触发器'
      : '🟡 当前脚本项目存在' + dexTriggers.length + '个重复刷新触发器');

  let streamStatus = '○ 快照表不足，等待样本';
  let lastFullTs = 0;
  let snapshotRows = 0;
  let capacityStatus = '○ 快照表未建立';
  let sourceStatus = '○ 尚无完整M5写入源指纹';
  let cacheStatus = '○ M5桶缓存未建立';

  if (snapshot) {
    snapshotRows = Math.max(0, snapshot.getLastRow() - 1);
    const maxRows = snapshot.getMaxRows();
    capacityStatus = maxRows >= RH_DEX_CFG.maxSnapshotRows
      ? '🟢 50,000行滚动保留｜当前' + snapshotRows + '行数据'
      : '🟡 当前物理行数' + maxRows + '｜脚本会按需扩容至50,000行滚动窗口';
  }

  if (snapshot && snapshot.getLastRow() >= 2) {
    const lastRow = snapshot.getLastRow();
    const startRow = Math.max(2, lastRow - 249);
    const readCols = Math.min(snapshot.getMaxColumns(), 18);
    const data = snapshot.getRange(startRow, 1, lastRow - startRow + 1, readCols).getValues();
    const cutoff = now.getTime() - 30 * 60 * 1000;
    let fullCount = 0;
    let basicCount = 0;
    let lastFull = 0;
    let lastBasic = 0;
    const sourceCounts = {};
    let untaggedFullCount = 0;

    data.forEach(function(r) {
      const ts = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) return;
      const hasM5 = r[12] !== '' && r[12] != null;
      if (hasM5) {
        fullCount++;
        if (ts > lastFull) lastFull = ts;
        const source = String(r[17] || '').trim();
        if (source) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        else untaggedFullCount++;
      } else {
        basicCount++;
        if (ts > lastBasic) lastBasic = ts;
      }
    });

    if (fullCount > 0 && basicCount > 0) {
      streamStatus = '🟡 检测到A:L基础流 + A:Q完整M5流并存；趋势只认M5完整流';
    } else if (fullCount > 0) {
      streamStatus = '🟢 近30分钟仅检测到完整M5流';
    } else if (basicCount > 0) {
      streamStatus = '🔴 近30分钟只有A:L基础流；趋势升级锁定';
    }

    lastFullTs = lastFull;

    const sourceParts = Object.keys(sourceCounts).sort().map(function(k) {
      return k + '×' + sourceCounts[k];
    });
    if (untaggedFullCount > 0) sourceParts.push('未标记完整流×' + untaggedFullCount);
    if (sourceParts.length) {
      sourceStatus = sourceParts.length === 1 && sourceCounts[RH_DEX_CFG.snapshotSourceTag] > 0 && untaggedFullCount === 0
        ? '🟢 近30分钟完整M5仅来自 ' + RH_DEX_CFG.snapshotSourceTag
        : '🟡 近30分钟完整M5来源：' + sourceParts.join(' / ');
    }

    if (lastFull && now.getTime() - lastFull > 12 * 60 * 1000) {
      streamStatus += '｜完整M5已超过12分钟未续写';
    }
  }

  let m5LastStatus = '○ 尚无完整M5快照';
  if (lastFullTs) {
    const ageMinutes = Math.max(0, Math.floor((now.getTime() - lastFullTs) / 60000));
    const prefix = ageMinutes <= 7 ? '🟢 ' : (ageMinutes <= 12 ? '🟡 ' : '🔴 ');
    m5LastStatus = prefix +
      Utilities.formatDate(new Date(lastFullTs), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') +
      '｜延迟' + ageMinutes + '分钟';
  }

  if (bucketCache) {
    const cacheRows = Math.max(0, bucketCache.getLastRow() - 1);
    if (cacheRows > 0) {
      const lastBucketValue = bucketCache.getRange(bucketCache.getLastRow(), 1).getValue();
      const lastBucketTs = lastBucketValue instanceof Date ? lastBucketValue.getTime() : new Date(lastBucketValue).getTime();
      const ageMinutes = Number.isFinite(lastBucketTs) ? Math.max(0, Math.floor((now.getTime() - lastBucketTs) / 60000)) : 999;
      cacheStatus = (ageMinutes <= 7 ? '🟢 ' : ageMinutes <= 12 ? '🟡 ' : '🔴 ') +
        '缓存' + cacheRows + '行｜最新桶延迟' + ageMinutes + '分钟';
    } else {
      cacheStatus = '○ M5桶缓存已建但尚无数据';
    }
  }

  const migrationSet = {};
  if (home && home.getLastRow() >= 2) {
    const hLast = Math.min(home.getLastRow(), 20);
    home.getRange(2, 38, hLast - 1, 5).getValues().forEach(function(r) {
      const ca = String(r[0] || '').trim().toLowerCase();
      const note = String(r[3] || '').trim();
      const status = String(r[4] || '').trim();
      if (ca && (note.indexOf('🟡 主池迁移待复核') === 0 || status.indexOf('🟡 主池迁移待复核') === 0)) {
        migrationSet[ca] = true;
      }
    });
  }
  if (radar && radar.getLastRow() >= 2) {
    const rLast = Math.min(radar.getLastRow(), 200);
    radar.getRange(2, 4, rLast - 1, 41).getValues().forEach(function(r) {
      const ca = String(r[0] || '').trim().toLowerCase();
      const status = String(r[40] || '').trim();
      if (ca && (status.indexOf('🟡 主池迁移待复核') === 0 || status.indexOf('🟡 首页主池迁移待同步') === 0)) {
        migrationSet[ca] = true;
      }
    });
  }
  const migrationCount = Object.keys(migrationSet).length;
  const migrationStatus = migrationCount === 0
    ? '🟢 当前无主池迁移待复核'
    : '🟡 当前' + migrationCount + '个CA主池迁移待复核';

  const props = PropertiesService.getScriptProperties();
  const flowSuccessTs = Number(props.getProperty('RH_LAST_AMOUNT_FLOW_SUCCESS_TS') || 0);
  const flowAttemptTs = Number(props.getProperty('RH_LAST_AMOUNT_FLOW_ATTEMPT_TS') || 0);
  const flowResult = String(props.getProperty('RH_LAST_AMOUNT_FLOW_RESULT') || '尚未尝试');
  const flowSkipped = Number(props.getProperty('RH_AMOUNT_FLOW_SKIPPED') || 0);
  let flowAudit = '○ 金额流旁路尚未成功';
  if (flowSuccessTs) {
    const ageMin = Math.max(0, Math.floor((now.getTime() - flowSuccessTs) / 60000));
    flowAudit = (ageMin <= RH_DEX_CFG.amountFlowMaxAgeMinutes ? '🟢 ' : '🟡 ') +
      'DexPaprika 1H金额流｜最后成功' + ageMin + '分钟前｜' + flowResult +
      (flowSkipped > 0 ? '｜配额保护跳过' + flowSkipped + '币' : '');
  } else if (flowAttemptTs) {
    flowAudit = '🟡 金额流已尝试但暂无成功｜' + flowResult;
  }

  upsertAuditRow_(settings, '运行脚本版本', '🟢 ' + RH_DEX_CFG.scriptVersion, '脚本每次刷新自报版本，避免把Library版本和实际部署版本混淆', '完整M5写入源：' + RH_DEX_CFG.snapshotSourceTag);
  upsertAuditRow_(settings, '当前项目触发器审计', triggerStatus, '运行 auditDexTriggers() 可手动复核', Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
  upsertAuditRow_(settings, '快照流健康', streamStatus, '双流可来自另一个Apps Script项目；当前项目无法删除外部项目触发器', '雷达按CA+Pair+M非空+5分钟桶去重');
  upsertAuditRow_(settings, 'M5最后成功', m5LastStatus, '完整M5超过7分钟转黄，超过12分钟转红', '用于趋势升级健康锁');
  upsertAuditRow_(settings, '完整M5写入源', sourceStatus, 'V6.1完整快照R列写入固定源指纹；旧A:L流和旧完整流默认无标记', '部署后若出现未标记完整流，说明仍有另一套完整脚本在写');
  upsertAuditRow_(settings, '1H金额流旁路', flowAudit, 'DexPaprika同主池1H buy_usd/sell_usd；每15分钟批量刷新，失败保留上次成功值', 'API分钟快照 S:W；W=' + RH_DEX_CFG.amountFlowSourceTag);
  upsertAuditRow_(settings, 'V6.2金额流结构', '🟢 S:W历史 + 雷达BT/BU实时 + 执行队列O列方向确认', 'installDexRefresh()自动补齐并写入资金流公式', '自动金额流30分钟TTL；手工回退90分钟TTL');
  upsertAuditRow_(settings, 'M5桶缓存健康', cacheStatus, '轻量缓存只服务短周期计算，长期归档仍看API分钟快照', '缓存上限10,000行；稳定后雷达优先读取缓存');
  upsertAuditRow_(settings, '权威升温口径', '🟢 BR/BS旁路', 'AF/AG仅旧兼容区；脚本不写BR/BS', '提醒与成绩单读取71列，并要求BR≥2才认趋势临战');
  upsertAuditRow_(settings, '主池迁移锁', migrationStatus, '首页为权威复核状态；雷达独立候选也保持黄锁', '深扫确认同池ATH/基准后人工标记“✅ 主池迁移已复核”');
  upsertAuditRow_(settings, '快照保留窗口', capacityStatus, '50,000行滚动保留，超出后删除最旧数据', '当前数据行：' + snapshotRows);
}

function upsertAuditRow_(sheet, key, value, purpose, note) {
  const lastRow = Math.max(1, sheet.getLastRow());
  const keys = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  let row = 0;
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0] || '').trim() === key) {
      row = i + 2;
      break;
    }
  }
  if (!row) row = lastRow + 1;
  sheet.getRange(row, 1, 1, 4).setValues([[key, value, purpose, note]]);
}

function toNum_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
