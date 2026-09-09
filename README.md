# RH Chain Monitor

Robinhood Chain monitoring stack. GitHub is the single source of truth for code; Google Sheet is the decision surface; Railway runs new-coin discovery.

## Components

- `apps-script/v6_2/*.gs` — stable `V6.2-flow-r3-flowlink`, split into maintainable Apps Script files. It runs 5-minute M5 monitoring, 15-minute DexPaprika amount flow, alerts, scorecard, cache and audit.
- `apps-script/rh_newcoin_ingest_v2.gs` — webhook receiver for the new-coin scanner. It preserves First Seen, globally deduplicates CA and writes raw facts only.
- `scanner/` — GitHub-source Railway service for Robinhood Chain Discovery. The clean rebuild currently enables Pons V2 and Uniswap v4/WETH discovery by default; v3 and wider quote-token coverage stay opt-in until their addresses are verified.
- Google Sheet pipeline: `新币发现 -> Canary候选 -> 热度雷达 -> 执行深核`.

## Design rule

Discovery is allowed to be early and noisy. Canary is where safety gates begin. The scanner never places orders.

## Current production baseline

The existing mature-token Sheet monitor is `V6.2-flow-r3-flowlink`. Do not mix older V4/V5 scripts back into the bound Apps Script project.

The new-coin scanner is a clean GitHub rebuild. It intentionally starts with verified/defaultable listeners rather than pretending to have full legacy v1.5 coverage on day one.

## Railway

The repository root contains a Railway-compatible `Dockerfile` and `railway.toml`; no source-code gzip/base64 environment-variable reconstruction is required.

Required variables for Sheet writes:

- `SHEET_WEBHOOK_URL`
- `SHEET_INGEST_SECRET`
- `RH_HTTP_URL`

Until the webhook is configured, the scanner can run with `DRY_RUN=true`; `/health` remains available.

See `docs/DEPLOYMENT.md` and `docs/ARCHITECTURE.md`.
