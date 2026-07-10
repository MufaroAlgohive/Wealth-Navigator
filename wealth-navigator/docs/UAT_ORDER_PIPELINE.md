# UAT Order Pipeline — Runbook

**Audience:** Mint OEM desk operators, the IRESS integration owner, the on-call engineer during Phase UAT.

**Scope:** End-to-end UAT for the OEMS order pipeline. From the moment a desk lead clicks **Send to Market** in `/oems/order-book` to the moment the `ExecutionView` shows the working → filled state transition with a live fill price.

**What this runbook covers:**

1. The end-to-end flow with file/line references.
2. Setting up the UAT environment on Railway + Vercel.
3. Three pre-canned UAT scenarios (test runner in the UI).
4. Failure modes + rollback.
5. How to disable UAT mode for production.

**Out of scope:** IRESS V4 entitlement for `TimeSeriesGet2` (T2 panels still blocked, see `TIMESERIES_UNBLOCK_PLAN.md`), FIX+ / IPS entitlements, the broker fill feed (`workers/broker-ingest/`), and Ozone wallet top-ups (`/oems/banking/wallet-topup`).

---

## 1. End-to-end flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Vercel (Next.js)                                                            │
│                                                                              │
│  /oems/order-book                                                            │
│  └─ UatBanner (poll /api/admin/orderbook/uat-status every 30s)               │
│  └─ UatTestRunner (3 scenarios → POST /api/admin/orderbook/send-to-market)   │
│  └─ ExecutionView (poll /api/admin/orderbook/execution every 30s            │
│                    + SSE /api/admin/orderbook/stream)                       │
│                                                                              │
│  /api/admin/orderbook/send-to-market (BFF)                                   │
│  1. RBAC (orderbook/send_to_market)                                          │
│  2. Read RETAIL `stock_holdings_c` for book_id, resolve securities/profiles  │
│  3. Insert N rows into INSTITUTIONAL `oems_order_audit`                     │
│     (status='working', payload.uat_test=true, source='OB_SEND_TO_MARKET_UAT')│
│  4. IF body.uat_test=true AND IRESS_UAT_MODE=true on Vercel                 │
│     AND IRESS_WORKER_URL set on Vercel:                                      │
│       For each row: callWorker POST /uat/send-to-market { order_audit_id }  │
│     ELSE:                                                                    │
│       Return { mode: "audit-only" } — desk uses /fills POST manually.        │
│                                                                              │
│  /api/admin/orderbook/uat-status (BFF)                                       │
│  └─ GET /uat/status on the worker (10s timeout)                              │
│                                                                              │
│  /api/admin/orderbook/stream (BFF SSE forwarder)                             │
│  └─ ReadableStream passthrough to worker /uat/execution-stream               │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Railway (Bun worker) — single replica, holds the MINT_CT IOS license seat   │
│                                                                              │
│  POST /uat/send-to-market (http-api.ts)                                      │
│  1. Reject if !IRESS_UAT_MODE                                                │
│  2. Reject if IRESS_UAT_ACCOUNT_CODE is empty                                │
│  3. Reject if account_code == IRESS_ACCOUNT_CODE (production)                │
│  4. Read oems_order_audit row by id                                          │
│  5. Build NewOrder { AccountCode: UAT, SecurityCode, Exchange: JSE,          │
│                      BuySell, OrderType: LMT|MKT, Volume, Price,             │
│                      Destination: LONGMARK CARE, TimeInForce: DAY }          │
│  6. sessions.getSession() — IOSPlus service session                          │
│  7. client.orderCreate3({ ServiceSessionKey, Order, OrderTag: <UUID> })      │
│     └─ If SOAP transport fails: try orderNoGetByOrderTag (idempotency)        │
│  8. UPDATE oems_order_audit SET                                              │
│        payload.iress_order_number = <OrderNumber>                            │
│        payload.uatOrderTag = <UUID>                                          │
│        payload.uatAccountCode = <UAT account>                                │
│        payload.uatSentAt = <now>                                             │
│        status = 'working' | 'rejected'                                       │
│  9. Publish to UatExecutionHub so /uat/execution-stream pushes the new order │
│                                                                              │
│  uatOrderLoop (main.ts, every IRESS_UAT_ORDER_POLL_SEC, default 30s)        │
│  └─ pollUatForFills → OrderPadGetByAccount(IRESS_UAT_ACCOUNT_CODE, WORKING)  │
│  └─ Match observed orders to audit rows by order_id (=iress_order_number)    │
│  └─ UPDATE each row: payload.filled, payload.avgPx,                          │
│                       result_payload.avgFillPrice,                           │
│                       result_payload.slippageBps, dayOnePnlCents,            │
│                       status = working|partial|filled|cancelled|rejected     │
│  └─ Publish deltas to UatExecutionHub                                        │
│                                                                              │
│  GET /uat/execution-stream (SSE)                                             │
│  └─ Push "status" frame on connect, then "delta" frames on each publish      │
│  └─ 25s keepalive ping so Vercel doesn't idle-kill the connection            │
│                                                                              │
│  GET /uat/status (snapshot)                                                  │
│  └─ { uatMode, uatAccountCode, lastPollAt, pollIntervalSec, workerId }      │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │ SOAP
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  IRESS MINT_CT IOS seat — webservices-ct.iress.co.za/v4                      │
│                                                                              │
│  IRESSSessionStart → ServiceSessionStart(Service=IOSPlus)                    │
│  OrderCreate3 (ServiceSessionKey) ← what the worker calls                   │
│  OrderPadGetByAccount (ServiceSessionKey, AccountCode, OrderFilter)          │
│  OrderDelete (ServiceSessionKey, OrderNumber)                                │
│  orderNoGetByOrderTag (ServiceSessionKey, OrderTag)  ← idempotency recovery   │
└──────────────────────────────────────────────────────────────────────────────┘
```

The single CT seat is held by the Railway worker — local dev uses `IRESS_MODE=mock` and the worker endpoints return `iress_mode_not_live` (503).

---

## 2. Setup

### 2.1 Railway worker (UAT)

Set on the `Iress-Worker` service:

```
IRESS_UAT_MODE=1
IRESS_UAT_ACCOUNT_CODE=<separate broker account — must differ from IRESS_ACCOUNT_CODE>
IRESS_UAT_ORDER_POLL_SEC=30
```

The startup log should print:

```json
{"level":"info","event":"starting","workerId":"iress-ingest-1",
 "iressMode":"live","uatMode":true,"uatAccountCode":"...","uatOrderPollSec":30}
[iress-ingest] UAT order poll ENABLED → account=... interval=30s
```

If `IRESS_UAT_ACCOUNT_CODE` is empty, the worker still boots (the production order poll is untouched) but logs:

```
[iress-ingest] IRESS_UAT_MODE=1 but IRESS_UAT_ACCOUNT_CODE is unset — UAT order routing will return 503. Set the UAT account to enable send-to-market.
```

### 2.2 Vercel (BFF)

Add to the Vercel project env (`wealth-navigator`):

```
IRESS_UAT_MODE=true
```

(IRESS_WORKER_URL is already set for Path B passthroughs; UAT routes use the same client.)

### 2.3 Verify

```bash
# Worker
curl -s -H "Authorization: Bearer $WORKER_HTTP_TOKEN" \
  https://iress-worker-production.up.railway.app/uat/status | jq

# BFF
curl -s https://wealth-navigator-one.vercel.app/api/admin/orderbook/uat-status \
  -H "Cookie: ..." | jq
```

Both should return `uat_mode: true` (Vercel) and `uatMode: true` (worker) plus a non-null `uatAccountCode`. The worker's `lastPollAt` should be a recent ISO timestamp.

### 2.4 Pre-flight checks

1. Run the worker `/debug/iress-methods` — `OrderCreate3` should report `ok` (requires `OrderPadGetByAccount` to also be `ok`).
2. Verify the UAT account has order entitlements: `IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4` + `IRESS_ALLOW_MUTATIONS=1` (debug-only) and probe `OrderCreate3` with a one-share `MKT` order on a test symbol. If 25014 entitlement, contact IRESS.
3. Confirm `oems_order_audit` exists in INSTITUTIONAL and is writable by the worker's service-role key.

---

## 3. UAT test scenarios

The Order Book page (`/oems/order-book`) renders a **UAT Test Runner** panel when UAT mode is on. Each scenario:

1. Seeds `stock_holdings_c` (RETAIL) under a `UAT-<scenario>-<timestamp>` book id.
2. Calls `POST /api/admin/orderbook/send-to-market` with `uat_test: true`.
3. Polls `/api/admin/orderbook/execution?book_id=...` and reports the state transitions.
4. (Scenario 3) calls `POST /api/orders/cancel` with the IRESS OrderNumber.

### Scenario 1 — Single SOL buy, watch it fill

- Symbol: SOL, qty: 400, side: buy, limit: R 177.00, venue: JSE, broker: LONGMARK CARE.
- Expected: working → filled within 1–2 poll cycles (SOL is a high-volume JSE name).
- Success criteria: `ExecutionView` shows `FILLED` with `avg_fill_price ≈ 177.00`, `% filled = 100`, slippage ≤ ±0.50.

### Scenario 2 — Basket of 5 mixed orders

| Symbol | Qty | Limit (R) | Side |
| ------ | --- | --------- | ---- |
| NPN    | 50  | 3 000.00  | BUY  |
| MTN    | 200 | 90.00     | BUY  |
| FSR    | 1 000 | 17.00   | BUY  |
| SBK    | 80  | 195.00    | BUY  |
| AGL    | 60  | 125.00    | BUY  |

- Expected: at least 2 of 5 filled within 5 poll cycles, the rest partial or working depending on liquidity.
- Success criteria: aggregate `book_ready_for_confirmation: true` only when all 5 are `FILLED`; partial-fill rows have a populated `avgPx`.

### Scenario 3 — Create + cancel an order

- Symbol: NPN, qty: 10, side: buy, limit: R 3 050.00 (1.5% above mid), venue: JSE, broker: LONGMARK CARE.
- Expected: working → cancelled.
- Success criteria: `ExecutionView` row reaches `CANCELLED` and the `ExecutionView` SSE delta log shows the `OrderDelete` event with the correct IRESS OrderNumber.

### Cleanup

Test rows are tagged `payload.uat_test = true` (and `source = OB_SEND_TO_MARKET_UAT`). Filter them out of production reports with:

```sql
-- One-off: remove all UAT test artefacts
DELETE FROM oems_order_audit WHERE payload->>'uat_test' = 'true';
DELETE FROM stock_holdings_c WHERE strategy_name_snapshot LIKE 'UAT-%';
```

---

## 4. Failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `UatBanner` doesn't render | `IRESS_UAT_MODE` not `true` on Vercel | Set on Vercel + redeploy. |
| Banner says "worker not in UAT mode" | Worker has `IRESS_UAT_MODE=0` or `IRESS_UAT_ACCOUNT_CODE` empty | Set on Railway + redeploy. |
| `/uat/send-to-market` returns 400 `wrong_account` | `body.account_code` matched `IRESS_ACCOUNT_CODE` | Caller bug — UAT caller must not pass the production account. |
| `/uat/send-to-market` returns 502 `iress_25001` after a successful start | IRESS killed the worker's IOS+ service session | The worker auto-recovers on the next request via `WorkerSessionManager.recoverDeadSession`; check `/debug/ips-session` for the last error. |
| `/uat/send-to-market` returns 502 `iress_25008` | Another process holds the CT license seat | Verify only ONE Railway replica is running (`Workers/iress-ingest` replicas = 1). If another client is logged in, run `bun run iress:logout` from `wealth-navigator/` to kick. |
| `/uat/send-to-market` returns 502 `no_order_number` | IRESS accepted the order but the response was empty | The worker falls back to `orderNoGetByOrderTag` automatically; if that also returns empty, check the `OrderTag` UUID is in `payload.uatOrderTag` and retry. |
| `/uat/send-to-market` returns 403 `uat_mode_disabled` | Worker hasn't redeployed since the env was set | Restart the worker. |
| `/uat/send-to-market` returns 503 `uat_account_not_configured` | `IRESS_UAT_ACCOUNT_CODE` empty | Set on Railway + restart. |
| `/uat/execution-stream` never fires | Worker's UAT poll is skipping (no orders in WORKING filter) | Check Railway logs for `uat order poll: skip=...`; the loop is filter=1 (WORKING) — once the broker transitions an order to FILLED the loop drops it intentionally. |
| `/uat/execution-stream` fires but the UI never shows the LIVE badge | Browser EventSource failed (network, auth) | Check the Network tab; the BFF `/api/admin/orderbook/stream` should return `text/event-stream`. |
| `oems_order_audit` row stuck on `working` despite broker showing `FILLED` | Worker restart between the create and the next poll, or UAT poll skipped | The next `OrderPadGetByAccount` cycle picks it up; if not, check the worker's `lastPollAt` and `integration_worker_health` for `license_seat_occupied`. |
| `worker.tearDown` doesn't release the seat on SIGTERM | Bug — rare; usually a network blip during `ServiceSessionEnd` | Run `bun run iress:logout` and `IRESS_FORCE_KICK_ALL=1 bun run iress:logout` from a local checkout. |

---

## 5. Disable UAT mode for production

Two flips — neither breaks the existing audit-only path.

### Worker (Railway)

```
IRESS_UAT_MODE=0
```

Redeploy. The startup log will print `"uatMode":false` and:

```
[iress-ingest] would NOT enable uat order poll (uatMode=false)
```

`/uat/send-to-market` returns 403 `uat_mode_disabled`. The UAT poll loop is a no-op. The production `orderLoop` continues to mirror the real `IRESS_ACCOUNT_CODE` exactly as before.

### Vercel (BFF)

```
IRESS_UAT_MODE=false
```

Redeploy. The `UatBanner` and `UatTestRunner` self-gate off (they return `null` when `/api/admin/orderbook/uat-status` reports `uat_mode: false`). The `send-to-market` BFF skips the worker fanout. The existing audit-only path (`/api/admin/orderbook/fills` POST) is the only way to ingest fills.

### Cleanup

```sql
-- Remove any UAT test artefacts (safe — only matches test rows)
DELETE FROM oems_order_audit WHERE payload->>'uat_test' = 'true';
DELETE FROM stock_holdings_c WHERE strategy_name_snapshot LIKE 'UAT-%';
```

---

## 6. References

- Worker code: `wealth-navigator/workers/iress-ingest/src/order-poller.ts` (UAT poll loop), `http-api.ts` (`/uat/*` routes), `main.ts` (uatOrderLoop), `env.ts` (UAT env).
- BFF: `wealth-navigator/src/app/api/admin/orderbook/send-to-market/route.ts`, `uat-status/route.ts`, `stream/route.ts`, `test-seed-holding/route.ts`.
- UI: `wealth-navigator/src/components/admin/order-book/page.tsx`, `uat-banner.tsx`, `uat-test-runner.tsx`, `execution-view.tsx` (SSE consumer).
- IRESS V4 reference: `Documentation & Vision/iress-v4-docs/05-services/ios-plus/` (OrderCreate3, OrderPadGetByAccount, OrderDelete).
- Architecture: `wealth-navigator/docs/STACK_ARCHITECTURE.md`, `docs/DB_TOPOLOGY_DECISION.md`, `docs/REMAINING_GAPS.md`.
- Go-live context: `wealth-navigator/docs/MINT_GO_LIVE_RUNBOOK.html`.
