# IRESS V4 Method Inventory & Worker Capability Gap

**Source of truth:** `Documentation & Vision/iress-v4-docs/` (master PDF + 89 support
docs + 16 SOAP samples), `wealth-navigator/src/lib/iress/{client,live,mock}.ts`,
`wealth-navigator/workers/iress-ingest/src/*.ts`.

**Generated:** 2026-06-13. **Mode at the time:** Railway worker runs
`IRESS_MODE=live` (holds the CT license seat); Vercel is `IRESS_MODE=mock` +
`USE_SUPABASE_QUOTES=true` reading real worker-ingested Supabase quotes.

---

## 1. Executive summary

The IRESS V4 spec exposes a few dozen methods across four services. The Wealth
Navigator adapter (`IressClient` interface in `src/lib/iress/client.ts`) ships
**17 methods** that cover the full end-to-end quote → order → book → portfolio
flow for the OEMS trading desk. The Railway `iress-ingest` worker exercises a
**strict subset** of those 17 — exactly the read-only paths it needs to ingest
quotes, time series, and order pads into Supabase for the Vercel BFF to read.

This document maps every method called out in the IRESS V4 quick reference
(`iress-v4-docs/10-reference/quick-reference/00-master.md`) against:

1. Whether the typed `IressClient` interface ships it (P0/P1/P2 gap).
2. Whether the live SOAP client implements it.
3. Whether the mock implements it (so the Vercel UI works in `IRESS_MODE=mock`).
4. Whether the Railway `iress-ingest` worker actually calls it.

The headline finding: **P0 gap is `OrderNoGetByOrderTag`**, the only documented
V4 method the OEMS would call on a recovery path that is *not* in the adapter.
Two more methods (`OrderPadGetByUser` / `OrderPadGetByAccountGroup`) are
deferred (P2) — the adapter's `orderPadGetByAccount` covers the only
account the OEMS ever serves (`IRESS_ACCOUNT_CODE` on Railway).

| Service | Total in spec | In adapter | In worker | P0 gap | P1 / P2 |
|--------|---------------|------------|-----------|--------|---------|
| Iress Pro (sessions + market data) | 6 + 1 audit | 6 | 3 | 0 | 1 (audit) |
| IOS+ (trading) | 14 | 6 | 1 | 1 | 7 |
| IPS (portfolio) | 8 | 1 | 0 | 0 | 7 |
| FIX+ | 2 | 2 | 0 | 0 | 0 |
| **Total** | **~31** | **15** (+2 updates = 17) | **4** | **1** | **~14** |

---

## 2. Per-method inventory

Status legend:

- `OK` — implemented in `IressClient` interface, live SOAP client, mock, and exercised by the worker (where applicable).
- `OK-WS-ONLY` — implemented in the interface and the worker pulls it, but it's not called by the BFF (worker-internal use only).
- `WIRED-NO-WORKER` — implemented in the interface + live + mock, but no Railway worker loop calls it (UI never exercises it today).
- `P0` — required for current OEMS flows (recovery, parity) and not in the adapter.
- `P1` — would be useful in the next iteration (Phase 2 / 3 spec coverage).
- `P2` — defer; spec only, no current ask.

### 2.1 Iress Pro — sessions

| Method | Spec | Adapter | Mock | Worker | Status | Notes |
|---|---|---|---|---|---|---|
| `IRESSSessionStart` | yes | yes | yes | yes | **OK** | 25008 recovery (kick on first-boot / orphan). |
| `IRESSSessionEnd` | yes | yes | yes | yes | **OK** | `tearDownIressWireSession`. |
| `ServiceSessionStart` | yes | yes | yes | yes | **OK** | `IOSPlus` / `IPS` / `FIXPlus` keyed off the IRESS session. |
| `ServiceSessionEnd` | yes | yes | yes | yes | **OK** | Worker tears down all 3 services before logout. |
| `ForceCloseSession` (admin) | yes | no | no | no | **P2** | Web admin only; we do not own the WS admin surface. |

### 2.2 Iress Pro — market data

| Method | Spec | Adapter | Mock | Worker | Status | Notes |
|---|---|---|---|---|---|---|
| `PricingQuoteGet` | yes | yes | yes | yes | **OK** | Primary tier-1 ingest path. `maybeLogRawQuoteRow` for CT field drift. |
| `PricingQuoteGetUpdates` | yes | yes | yes | n/a | **OK** | Long-polling shape. Mock returns empty `StatusCode=3`. |
| `PricingQuoteExGet` | yes | no | no | no | **P2** | Extended L1; L2 ask is unresolved (Charles ask #1 in `11-mint-oems/04-low-hanging-fruit.md`). |
| `PricingTradeHistoricalGet` | yes | no | no | no | **P2** | Trade-tape history. OEMS v1 doesn't surface a historical tape UI. |
| `TimeSeriesGet2` | yes | yes | yes | yes | **OK-WS-ONLY** | Worker polls ALSI / sector / curve. BFF reads Supabase, not IRESS. |
| `TimeSeriesGet2Updates` | yes | yes | yes | n/a | **OK-WS-ONLY** | Long-polling shape; no caller today. |
| `AuditTrailGetByAccount` | yes | no | no | no | **P1** | Compliance / audit trail for ops. Need Charles ask: do they want this surfaced in-app or is the PDF report fine? |

### 2.3 IOS+ — trading

| Method | Spec | Adapter | Mock | Worker | Status | Notes |
|---|---|---|---|---|---|---|
| `OrderCreate3` | yes | yes | yes | n/a | **OK** | Idempotency via `OrderTag`. Vercel BFF only — worker does not place orders. |
| `OrderAmend2` | yes | yes | yes | n/a | **OK** | Blotter amend path. |
| `OrderDelete` | yes | yes | yes | n/a | **OK** | Cancel path. |
| `OrderPadGetByAccount` | yes | yes | yes | yes | **OK** | Worker `OrderFilter=1` (working) every `IRESS_WORKER_ORDER_POLL_SEC` (60s). |
| `OrderPadGetByAccountUpdates` | yes | yes | yes | n/a | **OK** | Long-polling shape. |
| `OrderPadGetByUser` | yes | no | no | no | **P2** | OEMS serves one account (single `IRESS_ACCOUNT_CODE`); no need to filter by user. |
| `OrderPadGetByAccountGroup` | yes | no | no | no | **P2** | Same — OEMS does not model account groups. |
| `OrderSearchGetByUser` | yes | no | no | no | **P2** | Wider filter (date range, status). We do reconciliation with `BookingGetByOrganisation2` instead. |
| `OrderSearchGetByAccount` | yes | no | no | no | **P2** | Same as above, scoped to account. |
| **`OrderNoGetByOrderTag`** | **yes** | **no** | **no** | **no** | **P0** | **MISSING — see §3.** Recovery lookup: given a `mint-ord-…` tag we sent, return the broker's `OrderNumber`. Required for the post-`OrderCreate3` HTTP 500 / timeout recovery flow. |
| `BookingGetByOrganisation2` | yes | yes | yes | n/a | **OK** | Mock-only path today; booked-trade panel reads `oems_order_audit` + this. |
| `ETCGetByOrganisation` | yes | no | no | no | **P1** | Pre-trade cost estimates. Cockpit "arrival mid" compute lives in-app; the IRESS cost model would be a richer upgrade. |
| `DestinationGet` | yes | no | no | no | **P2** | Static list today; would lift to IRESS once we add a destination picker UI. |
| `DestinationDetailGet` | yes | no | no | no | **P2** | Pre-req for contingent orders (Phase 2). |
| `AttributeGetByUser` | yes | no | no | no | **P2** | Algo / IS / CO attributes. Phase 2 contingent orders. |
| `SessionRequestEnd` | yes | no | no | no | **P2** | Cancel a long-poll. Equivalent to closing the connection; transport layer handles. |

### 2.4 IPS — portfolio

| Method | Spec | Adapter | Mock | Worker | Status | Notes |
|---|---|---|---|---|---|---|
| `IPSTransactionGetByAccount5` | yes | yes | yes | n/a | **OK** | Backbone of the Blotter's "filled today" view. |
| `IPSAccountGetAll1` | yes | no | no | no | **P1** | Master list of accounts. We have a single hard-coded `MINT-LIVE-001` today. |
| `IPSPositionGetAll1` | yes | no | no | no | **P1** | Positions. OEMS v1 reads holdings from `securities_c` + `securities_holdings_c` (planned) instead. |
| `IPSUploadCreate1` | yes | no | no | no | **P2** | CSV / static-data upload. No current ask. |
| `IPSUploadDataSet1` | yes | no | no | no | **P2** | Same. |
| `IPSUploadRun1` | yes | no | no | no | **P2** | Same. |
| `IPSUploadSummaryGet2` | yes | no | no | no | **P2** | Same. |
| `IPSUploadErrorGet1` | yes | no | no | no | **P2** | Same. |

### 2.5 FIX+

| Method | Spec | Adapter | Mock | Worker | Status | Notes |
|---|---|---|---|---|---|---|
| `TargetIDGet` | yes | yes | yes | n/a | **OK** | Lists drop-copy targets. Cockpit's "FIX+ connected" pill. |
| `TargetIDStatusGet` | yes | yes | yes | n/a | **OK** | Per-target `LastSeq` + status. |

---

## 3. P0 gap: `OrderNoGetByOrderTag`

### Why it matters

The OEMS BFF (`/api/orders/...`) is the only place that calls `OrderCreate3`.
Today, if the SOAP call returns a transport-level failure (HTTP 500 from CT,
TCP RST mid-envelope, Vercel Function 30s timeout, etc.), the client sees a
hard 500 with no `OrderNumber`. We log the failure to `oems_order_audit` with
`status="rejected"` + the error message, but we **do not know whether IRESS
actually accepted the order**. Recovery is a manual "ask the broker" step.

`OrderNoGetByOrderTag` is the documented V4 recovery path: given the
`OrderTag` (UUID the OEMS minted), it returns the broker-assigned
`OrderNumber`. The OEMS BFF can re-query on a transient failure, and — if the
tag now resolves to an order — transition the audit row to `status="working"`.
This is the same idempotency contract the existing `orderCreate3` already
documents in `OrderTag` mode.

### Spec snapshot

> `OrderNoGetByOrderTag` — Recovery lookup. Given a tag we sent in
> `OrderCreate3.OrderTag`, return the broker-assigned `OrderNumber`. IOS+ service
> session only. No `Updates` companion method. (Source:
> `iress-v4-docs/10-reference/quick-reference/00-master.md`.)

### What the adapter needs to add

1. **Interface** — extend `IressClient` in `src/lib/iress/client.ts`:
   ```ts
   orderNoGetByOrderTag(req: {
     ServiceSessionKey: string;
     OrderTag: string;
   }): Promise<{ OrderNumber: string; OrderTag: string }>;
   ```
2. **Live** — implement in `src/lib/iress/live.ts` (SOAP envelope inferred
   from the `OrderPadGetByAccount` shape — same `Header` + `Parameters`
   pattern, single scalar `OrderTag` input, single `OrderNumber` output row).
3. **Mock** — implement in `src/lib/iress/mock.ts` (idempotent over the
   in-process `liveOrders[]` keyed by `orderTag`).
4. **BFF wiring** — when `/api/orders` `POST` returns 5xx, schedule a
   `orderNoGetByOrderTag` lookup on the same `OrderTag` with a 1.5s delay
   (CT license-seat-bound, so we don't hammer IRESS). If found, update the
   audit row and return the broker `OrderNumber` to the UI.
5. **Tests** — extend `iress-live.test.ts` (envelope shape, validation,
   end-to-end with a fake transport) + a new `iress-mock.test.ts` case for
   the mock + a BFF route test for the recovery path.
6. **Commit** — `feat(iress): add OrderNoGetByOrderTag for BFF recovery path`.

### Pre-implementation Charles ask

`OrderNoGetByOrderTag` is in the IRESS V4 quick reference. It is **not** in
the 6-month-old IA contract. Ask Charles to confirm: (a) the method is
entitled on the production account, and (b) the SOAP shape (input is just
`OrderTag`, output is a single `DataRow` with `OrderNumber` + echoed
`OrderTag`). The mock can ship without this; Railway will not exercise the
recovery path until Charles confirms.

---

## 4. P1 / P2 deferred methods

These are all spec'd in `iress-v4-docs/00-master.md` but not required for the
OEMS v1 trading desk. They are listed for completeness so the next planning
sprint can pick them up.

### P1 (next iteration)

- `AuditTrailGetByAccount` — operator compliance trail.
- `ETCGetByOrganisation` — pre-trade cost estimates (vs. our in-app compute).
- `IPSAccountGetAll1` + `IPSPositionGetAll1` — multi-account / positions.
  (OEMS v1 hard-codes `MINT-LIVE-001`.)

### P2 (defer)

- `PricingQuoteExGet`, `PricingTradeHistoricalGet` — extended L1 + tape
  history. Charles ask: depth-of-book vs. extended L1.
- `OrderPadGetByUser`, `OrderPadGetByAccountGroup`, `OrderSearchGetByUser`,
  `OrderSearchGetByAccount` — alternative order-pad views.
- `DestinationGet`, `DestinationDetailGet`, `AttributeGetByUser` — required
  for Phase 2 contingent / algo orders.
- `SessionRequestEnd` — long-poll cancellation. The transport already
  surfaces connection close.
- `IPSUpload*` — bulk static-data uploads.
- `ForceCloseSession` — admin surface, we don't own it.

---

## 5. Worker capability gap (the "what can the worker actually call" subset)

| Method | Worker calls | Why / when |
|---|---|---|
| `IRESSSessionStart` / `IRESSSessionEnd` | yes | On first boot, on license recovery, on shutdown. |
| `ServiceSessionStart` / `ServiceSessionEnd` (×3) | yes | `IOSPlus` + `IPS` + `FIXPlus`. |
| `PricingQuoteGet` | yes | Per watchlist symbol, every `IRESS_WORKER_QUOTE_INTERVAL_SEC` (15s). |
| `TimeSeriesGet2` | yes | ALSI / sector / curve, every `IRESS_WORKER_TIMESERIES_INTERVAL_SEC` (5 min). |
| `OrderPadGetByAccount` | yes | Per `IRESS_ACCOUNT_CODE`, every `IRESS_WORKER_ORDER_POLL_SEC` (60s). |
| `OrderCreate3` / `OrderAmend2` / `OrderDelete` | **no** | The worker is a polling mirror, not a control surface. Order placement stays on the Vercel BFF. |
| `IPSTransactionGetByAccount5` | **no** | BFF reads `oems_order_audit` (worker-mirrored) instead. |
| `TargetIDGet` / `TargetIDStatusGet` | **no** | Read once on demand from the Vercel side. |
| `BookingGetByOrganisation2` | **no** | BFF-level reconciliation only. |

The 14+ P1/P2 methods above are **not** called by the worker and would be
called from Vercel BFF code that doesn't exist yet (or ever, in some cases).

---

## 6. Structured worker events surfaced for diagnostics

The worker emits structured `console.info` / `console.warn` JSON lines the
integration page should surface so the user can diagnose "why isn't the worker
getting data" without tailing Railway logs.

| Event | Source file | When |
|---|---|---|
| `quote_raw_row` | `quotes.ts` (raw-row debug, opt-in via `IRESS_QUOTE_RAW_LOG`) | First NPN/BHG row at the bare-element-names level. |
| `quote_sync_complete` | `quotes.ts` | End of every watchlist sync round. `{requested, ok, empty, errors, sessionFatal}`. |
| `no DataRow` (warn) | `quotes.ts` | `PricingQuoteGet` returned no row — likely unknown symbol or market closed. |
| `no trade` (warn) | `quotes.ts` | Row present, `last=0` (pre-open / halt / closed / bogus Last). |
| `PricingQuoteGet(NPN) failed` (warn) | `quotes.ts` | Per-symbol error, includes `IressError` code + message. |
| `would_upsert_instrument` / `instrument_upserted` | `quotes.ts` | `IRESS_WORKER_INSTRUMENT_SYNC=1` path. |
| `missing_security` | `quotes.ts` | No `securities_c` row for an observed symbol. |
| `time_series_entitlement_missing` | `timeseries.ts` | 25014 / 25008 — ask Charles to flip the entitlement. |
| `time_series_no_data` | `timeseries.ts` | IRESS returned an empty series (holiday, market closed). |
| `would_upsert_index_intraday_c` / `sector_intraday_c` / `yield_curve_history_c` | `timeseries.ts` | Dry-run path. |
| `session ready` / `minting new ApplicationID` / `reusing sticky ApplicationID` | `session.ts` | Login / reconnect shape. |
| `25008 license seat occupied — backing off 60000ms` | `session.ts` | The headline license-exhausted event. |
| `dead IRESS session … — ending wire session and rebuilding` | `session.ts` | 25001 / 25003 / similar recovery. |
| `would upsert sticky application_id` / `would upsert worker_session_metadata` | `session.ts` | Dry-run. |
| `would upsert oems_order_audit` | `orders.ts` | Dry-run. |
| `heartbeat (dry-run)` | `supabase.ts` | Dry-run heartbeat. |
| `health loop error` | `health.ts` | Heartbeat loop exception. |
| `http api listening` | `http-api.ts` | Worker HTTP API started. |
| `http handler error` | `http-api.ts` | BFF passthrough exception. |

### Surfacing these in the integration page (Task 3)

The BFF endpoint `/api/worker-health` currently reads the
`integration_worker_health` row (heartbeat + last quote sync). Add a sibling
`/api/worker-events` (or extend `/api/worker-health` with an `events` array
populated from a new `worker_recent_events` JSONB column on
`integration_worker_health.metadata` — see Task 4). The integration page
adds a "Worker diagnostic events" panel: the most recent 50 structured events
for the primary worker, with severity colour-coding, expandable raw JSON, and
a deep-link to the matching IRESS error code doc.

---

## 7. Implementation order

1. **P0 #1 (already shipped)** — `PricingQuoteGet` CT field-name fallback
   (`<Last>` vs `<LastTrade>`, BHG OHLC cents cluster, stale `LastPrice` skip).
2. **P0 #2 (this PR)** — `OrderNoGetByOrderTag` for the BFF recovery path.
3. **P0 #3 (this PR)** — Surface worker diagnostic events in
   `/oems/integration` so the user can diagnose ingest failures without
   tailing Railway logs.
4. **P1** — `AuditTrailGetByAccount`, `ETCGetByOrganisation`,
   `IPSAccountGetAll1`, `IPSPositionGetAll1`. Trigger: OEMS Phase 2
   compliance / multi-account features.
5. **P2** — Algo / IS / CO contingent orders (drag in `DestinationDetailGet`,
   `AttributeGetByUser`). Trigger: OEMS Phase 2 contingent order UI.
