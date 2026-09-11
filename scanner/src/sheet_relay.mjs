import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_URL = String(process.env.VPS_OPPORTUNITY_URL || '').trim();
const RELAY_TOKEN = String(process.env.SHEET_RELAY_TOKEN || '').trim();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'vps-sheet-relay', upstreamConfigured: Boolean(UPSTREAM_URL) }));
    return;
  }

  if (url.pathname !== '/opportunity.csv' || !RELAY_TOKEN || url.searchParams.get('token') !== RELAY_TOKEN) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('unauthorized\n');
    return;
  }

  if (!UPSTREAM_URL) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('upstream_not_configured\n');
    return;
  }

  try {
    const upstream = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(15_000) });
    const body = await upstream.text();
    if (!upstream.ok) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('upstream_error\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-rh-relay-source': 'vps',
    });
    res.end(body);
  } catch (err) {
    console.error('[relay]', err?.message || err);
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('upstream_error\n');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[vps-sheet-relay] listening on :${PORT}`);
});
