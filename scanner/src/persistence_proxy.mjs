import http from 'node:http';
import { persistDiscoveryEvent, getDatabaseHealth } from './db.mjs';
import { persistLifecycleMilestone, getLifecycleMilestoneHealth, normalizeLifecyclePayloadTime } from './lifecycle_milestones.mjs';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function isDiscoveryPayload(payload) {
  if (!payload?.tokenCa && !payload?.token_address) return false;
  const stage = String(payload.stage || '').toLowerCase();
  return stage.includes('launched') || stage.includes('pool') || stage.includes('initialized') || stage.includes('discovery');
}

async function forward(upstreamUrl, upstreamSecret, payload) {
  if (!upstreamUrl) return { ok: true, skipped: 'upstream_not_configured' };
  const outbound = upstreamSecret ? { ...payload, secret: upstreamSecret } : payload;
  const res = await fetch(upstreamUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(outbound),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok || parsed?.ok === false) {
    throw new Error(`upstream webhook ${res.status}: ${text.slice(0, 300)}`);
  }
  return parsed || { ok: true };
}

export async function startPersistenceProxy({
  port = Number(process.env.PERSIST_PROXY_PORT || 3101),
  upstreamUrl = String(process.env.SHEET_WEBHOOK_URL || '').trim(),
  localSecret = 'sqlite-local-ingest',
  upstreamSecret = String(process.env.SHEET_INGEST_SECRET || '').trim(),
} = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          service: 'persistence-proxy',
          ...getDatabaseHealth(),
          lifecycle: getLifecycleMilestoneHealth(),
        }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      }
    }

    if (req.method !== 'POST' || req.url !== '/ingest') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    }

    try {
      const payload = await readJson(req);
      if (String(payload.secret || '') !== localSecret) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'bad_secret' }));
      }

      const lifecyclePayload = await normalizeLifecyclePayloadTime(payload);
      let lifecycleResult = { ok: true, skipped: true };
      if (lifecyclePayload?.tokenCa || lifecyclePayload?.token_address) {
        lifecycleResult = persistLifecycleMilestone(lifecyclePayload);
        if (!lifecycleResult?.ok && !lifecycleResult?.skipped) throw new Error('lifecycle_persist_failed');
      }

      let dbResult = { ok: true, skipped: true };
      if (isDiscoveryPayload(payload)) {
        dbResult = persistDiscoveryEvent(payload);
        if (!dbResult?.ok && !dbResult?.skipped) throw new Error('sqlite_persist_failed');
        console.log('[sqlite discovery]', JSON.stringify({
          token: dbResult.tokenAddress || payload.tokenCa || '',
          pool: dbResult.poolKey || payload.pool || '',
          poolInserted: Boolean(dbResult.poolInserted),
          stage: payload.stage || '',
        }));
      }

      const upstream = await forward(upstreamUrl, upstreamSecret, payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, db: dbResult, lifecycle: lifecycleResult, upstream }));
    } catch (err) {
      console.error('[persistence proxy]', String(err?.message || err));
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  console.log('[persistence proxy] listening', JSON.stringify({
    address: `http://127.0.0.1:${port}/ingest`,
    upstreamConfigured: Boolean(upstreamUrl),
    ...getDatabaseHealth(),
    lifecycle: getLifecycleMilestoneHealth(),
  }));
  return server;
}
