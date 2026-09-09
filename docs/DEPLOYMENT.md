# Deployment

## 1. Apps Script stable monitor

The bound Google Sheet project should contain all files under `apps-script/v6_2/`. Together they are the stable `V6.2-flow-r3-flowlink` currently used by the workbook. Run `installDexRefresh()` once after replacing an older project.

## 2. Apps Script scanner receiver

Add `apps-script/rh_newcoin_ingest_v2.gs` to an Apps Script project attached to the target workbook.

1. Script Properties: create `INGEST_SECRET` with a long random value.
2. Deploy as Web App with execution permission appropriate for the workbook.
3. Copy the `/exec` URL.
4. Set Railway `SHEET_WEBHOOK_URL` to the `/exec` URL.
5. Set Railway `SHEET_INGEST_SECRET` to the same secret.

The receiver writes only raw discovery facts into `新币发现`; Sheet formulas perform Discovery/Canary scoring.

## 3. Railway scanner

Deploy this GitHub repository directly from `main`. The root `Dockerfile` and `railway.toml` are sufficient; do not use the legacy source-fragment start command.

Recommended variables:

```text
RH_HTTP_URL=https://rpc.mainnet.chain.robinhood.com
BACKFILL_BLOCKS=120
POLL_MS=2000
HEARTBEAT_MS=30000
DRY_RUN=false
```

The current Pons V2 factory, Uniswap v4 PoolManager and WETH defaults are in code and can be overridden by environment variables. V3 is disabled until `UNIV3_FACTORY` is explicitly supplied. Additional USDG/stock quote tokens can be supplied through `QUOTE_TOKENS` after verification.

For first boot, `DRY_RUN=true` is safe: the service scans and exposes health without writing to Sheet. After the Apps Script Web App is configured, set the webhook variables and switch to `DRY_RUN=false`.

## 4. Health

Railway healthcheck: `/health`.

A healthy response should show `ok: true`, a changing `lastBlock`, and—after webhook setup—`webhookConfigured: true`.

## Why the old Railway deployment failed

The old service reconstructed source from `SCANNER_GZ_1..10` environment-variable fragments and checked a hard-coded SHA256. The fragments and expected digest diverged, causing a restart loop before the scanner process started. GitHub source deployment removes that entire failure mode.
