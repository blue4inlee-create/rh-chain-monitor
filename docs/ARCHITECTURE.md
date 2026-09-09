# Architecture

## Stable monitor

Google Apps Script `dex_refresh_v6_2_flow.gs` runs the mature-token monitor:

1. DexScreener: price, LP, h1/h24 volume, buys/sells, m5 volume/txns/price.
2. DexPaprika: 1h buy USD / sell USD amount flow every 15 minutes.
3. Sheet formulas: canonical warm-up state, amount-flow confirmation, safety gates, deep-review queue, scorecard.

## New-coin discovery

Railway `scanner` watches chain events and posts raw facts to the Apps Script receiver.

`scanner -> rh_newcoin_ingest_v2.gs -> 新币发现 -> Canary候选`

The webhook receiver deliberately does not calculate scores. It only normalizes event field aliases, globally deduplicates by CA, preserves First Seen, and updates raw facts.

## Promotion

- Discovery: raw new launch / new pool, no manual review.
- Canary-1: enough liquidity/activity to keep collecting.
- Canary-2: high enough score to spend manual safety-review time.
- Heat radar: only after safety review passes.
- Execution candidate: still requires the existing mature-monitor gates.

No auto-trading is implemented.
