import { createPublicClient, http as viemHttp } from 'viem';
import { getDatabase } from './db.mjs';

const RPC_URL = process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com';
const chainClient = createPublicClient({
  chain: {
    id: 4663,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
  transport: viemHttp(RPC_URL, { timeout: 12000, retryCount: 1 }),
});
const blockTimeCache = new Map();

function txt(v) {
  return v == null ? '' : String(v).trim();
}

function lc(v) {
  return txt(v).toLowerCase();
}

function iso(v) {
  const s = txt(v);
  if (!s) return '';
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

function secondsBetween(a, b) {
  const x = Date.parse(a || '');
  const y = Date.parse(b || '');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return (y - x) / 1000;
}

async function chainTimeForBlock(blockNumber) {
  const n = Number(blockNumber || 0);
  if (!Number.isInteger(n) || n <= 0) return '';
  if (blockTimeCache.has(n)) return blockTimeCache.get(n);
  try {
    const block = await chainClient.getBlock({ blockNumber: BigInt(n) });
    const value = new Date(Number(block.timestamp) * 1000).toISOString();
    blockTimeCache.set(n, value);
    if (blockTimeCache.size > 500) blockTimeCache.delete(blockTimeCache.keys().next().value);
    return value;
  } catch (err) {
    console.warn('[lifecycle block-time]', JSON.stringify({ block:n, error:String(err?.message || err) }));
    return '';
  }
}

export async function normalizeLifecyclePayloadTime(payload = {}) {
  if (iso(payload.chainTime)) return payload;
  const stage = txt(payload.stage).toLowerCase();
  const needsExactBlockTime = stage.includes('poolgraduated') || (stage.includes('v4') && stage.includes('initialized'));
  if (!needsExactBlockTime) return payload;
  const block = Number(payload.block || payload.block_number || 0);
  const chainTime = await chainTimeForBlock(block);
  return chainTime ? { ...payload, chainTime } : payload;
}

export function ensureLifecycleMilestoneSchema() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_milestones (
      token_address TEXT PRIMARY KEY,
      launch_at TEXT NOT NULL DEFAULT '',
      launch_block INTEGER,
      launch_tx TEXT NOT NULL DEFAULT '',
      curve_address TEXT NOT NULL DEFAULT '',
      first_swap_at TEXT NOT NULL DEFAULT '',
      first_swap_block INTEGER,
      first_swap_tx TEXT NOT NULL DEFAULT '',
      first_swap_direction TEXT NOT NULL DEFAULT '',
      graduated_at TEXT NOT NULL DEFAULT '',
      graduated_block INTEGER,
      graduated_tx TEXT NOT NULL DEFAULT '',
      v4_pool_at TEXT NOT NULL DEFAULT '',
      v4_pool_block INTEGER,
      v4_pool_tx TEXT NOT NULL DEFAULT '',
      v4_pool_key TEXT NOT NULL DEFAULT '',
      launch_to_first_swap_sec REAL,
      launch_to_graduated_sec REAL,
      graduated_to_v4_sec REAL,
      launch_to_v4_sec REAL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_graduated_at ON lifecycle_milestones(graduated_at);
    CREATE INDEX IF NOT EXISTS idx_lifecycle_v4_pool_at ON lifecycle_milestones(v4_pool_at);
  `);
}

function loadRow(db, token) {
  return db.prepare('SELECT * FROM lifecycle_milestones WHERE token_address=?').get(token) || null;
}

function baseUpsert(db, token, now) {
  db.prepare(`
    INSERT INTO lifecycle_milestones (token_address, updated_at)
    VALUES (?, ?)
    ON CONFLICT(token_address) DO UPDATE SET updated_at=excluded.updated_at
  `).run(token, now);
}

export function persistLifecycleMilestone(payload = {}) {
  const token = lc(payload.tokenCa || payload.token_address);
  if (!/^0x[a-f0-9]{40}$/.test(token)) return { ok: false, skipped: true, reason: 'invalid_token' };

  ensureLifecycleMilestoneSchema();
  const db = getDatabase();
  const stage = txt(payload.stage).toLowerCase();
  const now = new Date().toISOString();
  const eventAt = iso(payload.chainTime || payload.firstSeen || payload.event_time || payload.lastUpdate) || now;
  const block = Number.isFinite(Number(payload.block || payload.block_number)) ? Number(payload.block || payload.block_number) : null;
  const txHash = lc(payload.txHash || payload.tx_hash);
  const pool = lc(payload.pool || payload.pool_address || payload.pool_key);
  const direction = txt(payload.direction).toLowerCase();

  return db.transaction(() => {
    baseUpsert(db, token, now);

    if (stage.includes('tokenlaunched') || stage === 'launched') {
      db.prepare(`
        UPDATE lifecycle_milestones SET
          launch_at=CASE WHEN launch_at='' THEN ? ELSE launch_at END,
          launch_block=COALESCE(launch_block, ?),
          launch_tx=CASE WHEN launch_tx='' THEN ? ELSE launch_tx END,
          curve_address=CASE WHEN curve_address='' THEN ? ELSE curve_address END,
          updated_at=?
        WHERE token_address=?
      `).run(eventAt, block, txHash, /^0x[a-f0-9]{40}$/.test(pool) ? pool : '', now, token);
    } else if (stage.includes('first swap')) {
      db.prepare(`
        UPDATE lifecycle_milestones SET
          first_swap_at=CASE WHEN first_swap_at='' THEN ? ELSE first_swap_at END,
          first_swap_block=COALESCE(first_swap_block, ?),
          first_swap_tx=CASE WHEN first_swap_tx='' THEN ? ELSE first_swap_tx END,
          first_swap_direction=CASE WHEN first_swap_direction='' THEN ? ELSE first_swap_direction END,
          curve_address=CASE WHEN curve_address='' THEN ? ELSE curve_address END,
          updated_at=?
        WHERE token_address=?
      `).run(eventAt, block, txHash, direction, /^0x[a-f0-9]{40}$/.test(pool) ? pool : '', now, token);
    } else if (stage.includes('poolgraduated') || stage === 'graduated') {
      db.prepare(`
        UPDATE lifecycle_milestones SET
          graduated_at=CASE WHEN graduated_at='' THEN ? ELSE graduated_at END,
          graduated_block=COALESCE(graduated_block, ?),
          graduated_tx=CASE WHEN graduated_tx='' THEN ? ELSE graduated_tx END,
          updated_at=?
        WHERE token_address=?
      `).run(eventAt, block, txHash, now, token);
    } else if (stage.includes('v4') && stage.includes('initialized')) {
      db.prepare(`
        UPDATE lifecycle_milestones SET
          v4_pool_at=CASE WHEN v4_pool_at='' THEN ? ELSE v4_pool_at END,
          v4_pool_block=COALESCE(v4_pool_block, ?),
          v4_pool_tx=CASE WHEN v4_pool_tx='' THEN ? ELSE v4_pool_tx END,
          v4_pool_key=CASE WHEN v4_pool_key='' THEN ? ELSE v4_pool_key END,
          updated_at=?
        WHERE token_address=?
      `).run(eventAt, block, txHash, pool, now, token);
    }

    const row = loadRow(db, token);
    const launchToFirstSwapSec = secondsBetween(row?.launch_at, row?.first_swap_at);
    const launchToGraduatedSec = secondsBetween(row?.launch_at, row?.graduated_at);
    const graduatedToV4Sec = secondsBetween(row?.graduated_at, row?.v4_pool_at);
    const launchToV4Sec = secondsBetween(row?.launch_at, row?.v4_pool_at);

    db.prepare(`
      UPDATE lifecycle_milestones SET
        launch_to_first_swap_sec=?,
        launch_to_graduated_sec=?,
        graduated_to_v4_sec=?,
        launch_to_v4_sec=?,
        updated_at=?
      WHERE token_address=?
    `).run(launchToFirstSwapSec, launchToGraduatedSec, graduatedToV4Sec, launchToV4Sec, now, token);

    const finalRow = loadRow(db, token);
    const changed = stage.includes('tokenlaunched') || stage.includes('first swap') || stage.includes('poolgraduated') || (stage.includes('v4') && stage.includes('initialized'));
    if (changed) {
      console.log('[lifecycle]', JSON.stringify({
        token,
        stage: payload.stage || '',
        launchAt: finalRow?.launch_at || '',
        firstSwapAt: finalRow?.first_swap_at || '',
        graduatedAt: finalRow?.graduated_at || '',
        v4PoolAt: finalRow?.v4_pool_at || '',
        launchToFirstSwapSec: finalRow?.launch_to_first_swap_sec ?? null,
        launchToGraduatedSec: finalRow?.launch_to_graduated_sec ?? null,
        graduatedToV4Sec: finalRow?.graduated_to_v4_sec ?? null,
        launchToV4Sec: finalRow?.launch_to_v4_sec ?? null,
      }));
    }
    return { ok: true, changed, row: finalRow };
  })();
}

export function getLifecycleMilestoneHealth() {
  ensureLifecycleMilestoneSchema();
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN launch_at<>'' THEN 1 ELSE 0 END) AS launched,
      SUM(CASE WHEN first_swap_at<>'' THEN 1 ELSE 0 END) AS first_swaps,
      SUM(CASE WHEN graduated_at<>'' THEN 1 ELSE 0 END) AS graduated,
      SUM(CASE WHEN v4_pool_at<>'' THEN 1 ELSE 0 END) AS v4_pools,
      SUM(CASE WHEN graduated_at<>'' AND v4_pool_at<>'' THEN 1 ELSE 0 END) AS graduated_v4_linked,
      MAX(updated_at) AS latest_update
    FROM lifecycle_milestones
  `).get();
  return {
    total: Number(row?.total || 0),
    launched: Number(row?.launched || 0),
    firstSwaps: Number(row?.first_swaps || 0),
    graduated: Number(row?.graduated || 0),
    v4Pools: Number(row?.v4_pools || 0),
    graduatedV4Linked: Number(row?.graduated_v4_linked || 0),
    latestUpdate: row?.latest_update || null,
  };
}
