# Broker Feed Integration

> **Phase C4** of the Mint OEM Finalisation Plan (`docs/MINT_FINALISATION_PLAN.md`).
> Status: **MOCK ONLY** — real broker vendor still pending (Lonwabo).

## Overview

The order-book workflow (Phase B3) ships orders as `status='working'`
rows in `oems_order_audit`. The broker-feed worker — `workers/broker-ingest/`
— polls the broker API for execution reports and converts them into fills
on those same rows. When every row in a book is `status='filled'` the
matching `rebalance_request_c` row is promoted to `status='executed'`
with `executed_at` stamped.

```
┌─────────────┐   poll every 60s   ┌─────────────────────┐
│ Broker API  │◄──── fetch fills ──│ broker-ingest worker │
└─────────────┘                    │ (Railway)            │
                                   └────────┬────────────┘
                                            │ upsert (mock = synthesise)
                                            ▼
                            ┌────────────────────────────────┐
                            │ INSTITUTIONAL `oems_order_audit`│
                            │   payload.filled               │
                            │   payload.avgPx                │
                            │   result_payload.avgFillPrice  │
                            │   result_payload.dayOnePnlCents│
                            │   result_payload.slippageBps   │
                            └────────────────┬───────────────┘
                                             │ every row filled → 'executed'
                                             ▼
                            ┌────────────────────────────────┐
                            │ INSTITUTIONAL                  │
                            │   `rebalance_request_c`        │
                            │   status='executed'            │
                            └────────────────┬───────────────┘
                                             │
                                             ▼
                                BFF / Finance tab reads
                                dayOnePnlCents totals
```

## Data flow

1. Operator dispatches an IC-approved rebalance via
   `POST /api/rebalance/requests/[id]/push` (Phase B1). The BFF
   materialises one `oems_order_audit` row per ISIN with
   `status='working'` and a populated `price_cents` (limit).
2. `broker-ingest` polls every 60 s (`BROKER_POLL_INTERVAL_MS`). Mock
   mode synthesises a fill per working row; live mode (vendor pending)
   would call `BROKER_API_URL/fills?since={cursor}` with
   `Bearer BROKER_API_KEY`.
3. Worker applies the fills: `status='filled'` when cumulative qty ≥
   row quantity, else `partial`.
4. Once all rows for a book are `filled`, the worker flips the matching
   `rebalance_request_c.status='executed'`.
5. The Finance tab reads `result_payload.dayOnePnlCents` (per row) and
   sums it; the Cockpit's Day-1 P&L is the cross-strategy total.

## Failure modes + recovery

| Failure | Worker response | Operator action |
|---|---|---|
| `INSTITUTIONAL_SUPABASE_*` missing | Worker logs warning + exits no-op | Set the env pair on Railway |
| Mock mode fill for `qty=0` audit rows | Skipped silently | Verify the rebalance push payload |
| `oems_order_audit` not migrated | Schema-missing log; worker keeps running | Apply `20260612000002_oems_order_audit.sql` on INSTITUTIONAL |
| `rebalance_request_c` not migrated | Audit row still flips to `filled`; rebalance left as-is | Apply `20260710000004_rebalance_request_c.sql` |
| Live broker fetch entitlements not flipped | Empty fills; warning logged | Vendor pending — wait for Lonwabo |

The worker is **safe to redeploy mid-day**: in-memory cursor resets on
restart but the next poll re-derives fill state from `oems_order_audit`
rows, so no execution data is lost.

## Manual fill injection

Used by `POST /api/admin/orderbook/fills` (Phase B3) AND directly via
the worker's `POST /debug/inject-fill` for verification:

```bash
curl -X POST https://broker-ingest.up.railway.app/debug/inject-fill \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "<rebalance_request_c.id>",
    "symbol": "NPN",
    "qty": 100,
    "avg_fill_price_cents": 245000,
    "fill_timestamp": "2026-07-09T11:30:00Z"
  }'
```

Returns the same shape the worker uses internally — `updated`,
`booksCompleted`, `rebalanceRequestIdsExecuted`, `totalDayOnePnlCents`.

## Health surface

The worker's `/health` is reverse-proxied by the Vercel BFF at
`/api/integration/health`. Phase C4 extends that response with a
`broker` field:

```jsonc
{
  "ok": true,
  "worker": { /* IRESS worker */ },
  "broker": {
    "status": "mock" | "live" | "unconfigured" | "degraded",
    "details": { /* full /health snapshot */ },
    "error": null
  },
  // convenience aliases
  "brokerMode": "mock",
  "brokerPollIntervalMs": 60000,
  "brokerFillsApplied": 12
}
```

`status` semantics:
- **live** — writes enabled, `BROKER_MODE=live`, both gates off.
- **mock** — writes enabled (or dry-run); `BROKER_MODE=mock`.
- **unconfigured** — `BROKER_WORKER_URL` not set on Vercel.
- **degraded** — worker reachable but errored (`broker.state.lastError` non-null).

## Related files

- `wealth-navigator/workers/broker-ingest/` — worker source
- `wealth-navigator/workers/broker-ingest/README.md` — ops playbook
- `wealth-navigator/src/app/api/integration/health/route.ts` — health BFF
- `wealth-navigator/src/app/api/admin/orderbook/fills/route.ts` — Phase B3 fills endpoint
- `wealth-navigator/src/app/api/rebalance/requests/[id]/push/route.ts` — generates the working rows this worker fills
- `wealth-navigator/src/app/admin/finance/page.tsx` — Finance tab reading `dayOnePnlCents`
