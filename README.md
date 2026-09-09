# RH Chain Monitor

Robinhood Chain monitoring stack. GitHub is the single source of truth for code; Google Sheet is the decision surface; Railway runs new-coin discovery.

## Components

- `apps-script/dex_refresh_v6_2_flow.gs` — stable 5-minute M5 + 15-minute amount-flow monitor used by the existing Google Sheet.
- `apps-script/rh_newcoin_ingest_v2.gs` — webhook receiver for new-coin scanner. CA dedupe, First Seen preservation, raw-facts-only writes.
- `scanner/` — Railway service for Robinhood Chain Discovery. It monitors current Pons V2 and Uniswap v4 by default; v3 is opt-in after address verification.
- Google Sheet pipeline: `新币发现 -> Canary候选 -> 热度雷达 -> 执行深核`.

## Design rule

Discovery is allowed to be early and noisy. Canary is where safety gates begin. The scanner never places orders.

## Current production baseline

The existing Sheet monitor is `V6.2-flow-r3-flowlink`. Do not mix older V4/V5 scripts back into the bound Apps Script project.

## Railway

Set the service root directory to `scanner` and deploy from this repository. Required variables for Sheet writes:

- `SHEET_WEBHOOK_URL`
- `SHEET_INGEST_SECRET`
- `RH_HTTP_URL`

Until the webhook is configured, the scanner can run with `DRY_RUN=true`; `/health` remains available.

See `docs/DEPLOYMENT.md` and `docs/ARCHITECTURE.md`.
