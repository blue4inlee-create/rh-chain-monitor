import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT || 8080);
const RELAY_TOKEN = String(process.env.SHEET_RELAY_TOKEN || '').trim();
const UPSTREAM_EXPORT_TOKEN = String(process.env.RESULT_EXPORT_TOKEN || '').trim();
const UPSTREAM_IP = String(process.env.VPS_UPSTREAM_IP || '').trim();
const UPSTREAM_SERVERNAME = String(process.env.VPS_UPSTREAM_SERVERNAME || '').trim();

const UPSTREAMS = new Map([
  ['/opportunity.csv', String(process.env.VPS_OPPORTUNITY_URL || '').trim()],
  ['/history.csv', String(process.env.VPS_HISTORY_URL || '').trim()],
  ['/calibration.csv', String(process.env.VPS_CALIBRATION_URL || '').trim()],
]);

function readUpstream(upstreamUrl) {
  const target = new URL(upstreamUrl);
  if (UPSTREAM_EXPORT_TOKEN && target.pathname.startsWith('/export/')) {
    target.searchParams.set('token', UPSTREAM_EXPORT_TOKEN);
  }
  const connectHost = UPSTREAM_IP || target.hostname;
  const servername = UPSTREAM_SERVERNAME || target.hostname;
  const port = Number(target.port || 443);
  const path = `${target.pathname}${target.search}`;

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      host: connectHost,
      port,
      path,
      method: 'GET',
      servername,
      rejectUnauthorized: true,
      headers: {
        Host: target.host,
        'User-Agent': 'rh-vps-sheet-relay/1.4',
        Accept: 'text/csv,*/*;q=0.8',
      },
    }, (upstream) => {
      const chunks = [];
      let size = 0;
      upstream.on('data', (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          upstream.destroy(new Error('upstream_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      upstream.on('end', () => resolve({ status: Number(upstream.statusCode || 0), body: Buffer.concat(chunks) }));
      upstream.on('error', reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error('upstream_timeout')));
    request.on('error', reject);
    request.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    const configured = Object.fromEntries([...UPSTREAMS.entries()].map(([path, value]) => [path, Boolean(value)]));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'vps-sheet-relay', configured, directIpConfigured: Boolean(UPSTREAM_IP) }));
    return;
  }

  const upstreamUrl = UPSTREAMS.get(url.pathname);
  if (!upstreamUrl || !RELAY_TOKEN || url.searchParams.get('token') !== RELAY_TOKEN) {
    res.writeHead(upstreamUrl ? 401 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(upstreamUrl ? 'unauthorized\n' : 'not_found\n');
    return;
  }

  try {
    const upstream = await readUpstream(upstreamUrl);
    if (upstream.status < 200 || upstream.status >= 300) {
      console.error('[relay upstream status]', JSON.stringify({ path: url.pathname, status: upstream.status }));
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('upstream_error\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-rh-relay-source': 'vps',
      'x-rh-relay-path': url.pathname,
    });
    res.end(upstream.body);
  } catch (err) {
    console.error('[relay]', JSON.stringify({ path: url.pathname, message: err?.message || String(err), code: err?.code || err?.cause?.code || '', cause: err?.cause?.message || '' }));
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('upstream_error\n');
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[vps-sheet-relay] listening on :${PORT}`));
