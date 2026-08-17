# Wealth Navigator — IRESS V4 Integration & Order Lifecycle

**Audience:** developers, ops, on-call engineers.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/src/lib/iress/`, `wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`, `wealth-navigator/docs/IRESS_PRICE_SCALE_INCIDENT_HANDOFF.md`, `wealth-navigator/docs/SENS_NEWSHEADLINE_WIRE.md`, `wealth-navigator/docs/UAT_ORDER_PIPELINE.md`, `wealth-navigator/docs/VENDOR_ENTITLEMENT_STATUS.md`, `Wealth Navigator/Documentation & Vision/iress-v4-docs/`, `wealth-navigator/docs/MINT_PRODUCTION_READINESS_AUDIT.md`.

> **Correction vs older handoffs:** The `IressClient` surface has **23 methods** (not 17). Fault code `25008` is primarily a **license-seat dispute** (single replica holds the seat; no second replica allowed).

---

## 1. IRESS V4 — what we talk to

IRESS V4 is a **SOAP** Web Services stack provided by IRESS (JSE member-firm trading network). Reference docs at `Documentation & Vision/iress-v4-docs/`:
- `iress-programmers-guide.pdf` (the canonical programmer reference)
- `iress-v4-wsdl.zip` (WSDL bundle)
- `Notes - IRESS IOS+.txt`
- `Notes - IRESS IPS.txt`

### Endpoints
| Env | URL | Account | IOS+ server | News vendor |
|---|---|---|---|---|
| **Production** | `https://webservices.iress.co.za/v4` | `43448` | `MINT` | `SENSD` (only vendor the prod seat is entitled to) |
| **UAT / CT** | `https://webservices-ct.iress.co.za/v4` | `56378` | `MINT_CT` | `SENS` (real-time, UAT only) |

`wealth-navigator/src/lib/iress/index.ts:74` defaults `IRESS_BASE_URL=https://webservices.iress.co.za/v4`. `lib/iress/index.ts:230` defaults `IRESS_IOS_SERVER=MINT`. The worker `main-prod.ts` **refuses** `webservices-ct.*` as the base URL.

### Vendor terminology
- **IOS+ / IOSPlus** — IRESS Order Service Plus. Handles Orders / Users / Accounts / Limits. Server name `MINT` on prod.
- **IPS** — IRESS Portfolio Service. Handles accounts, positions, transactions. Methods: `IPSAccountGetAll1`, `IPSPositionGetAll1`, `IPSTransactionGetByAccount5`.
- **FIX+** — IRESS FIX+ drop-copy TCP connection. Methods: `TargetIDGet`, `TargetIDStatusGet`. Modeled but **not connected in v2**.
- **NewsHeadlineGet** — vendor content endpoint. Returns `SENSD` on prod seat.

---

## 2. Adapter layout

```
wealth-navigator/src/lib/iress/
├── index.ts                # Public re-exports (getIressClient, env defaults)
├── config.ts               # iressConfig — endpoints, account code, server names
├── client.ts               # IressClient — facade with all 23 methods
├── live.ts                 # IressLive — SOAP client + SOAP envelope mapping
├── mock.ts                 # IressMock — deterministic in-memory mock adapter
├── data-policy.ts          # Policy gate (mock vs live vs supabase vs worker)
├── worker-api.ts           # Worker passthrough (Path B) plumbing
├── approved-symbols.ts     # Fail-closed IRESS price gate
├── orders.ts               # Order create / cancel / amend helpers
├── errors.ts               # Fault code mapping (25008, 25002, 25014, 25015, 25018)
├── __tests__/              # Adapter unit tests
└── docs/                   # Notes, behaviour logs, SOAP envelope notes
```

### `IressClient` surface (23 methods)

Per `wealth-navigator/src/lib/iress/client.ts:184-202` and the SOAP/WSDL mapping. The full method surface:

#### Health + session
1. `getHealth()` — adapter liveness + entitlement check (maps to `NewsHeadlineGet` vendor probe).
2. `serviceSessionStart(service: "IOS" | "IPS" | "FIX")` — open a SOAP session for a service.
3. `serviceSessionEnd(session: SessionHandle)` — release.
4. `serviceSessionGet(sessionId)` — recover an existing session.

#### Market data (T1 — snapshots)
5. `pricingQuoteGet(symbol, exchange?, side?)` — single-symbol quote. Returns `{ lastPrice, prevClose, change, changePct, bid, ask, size, ts }`.
6. `pricingQuoteGetAll(symbols: string[])` — batch quote.
7. `marketDataSubscribe(symbols)` — server-side subscription (used by worker hot loop).
8. `timeSeriesGet(code, exchange, source?, from, to, interval?)` — historical time series.
9. `timeSeriesGetIndex(code, exchange, source?, from, to, interval?)` — indexed series (ALSI/J203).

#### Order book + depth
10. `orderBookGet(symbol, exchange, depth?)` — L2 market depth.
11. `timeAndSalesGet(symbol, exchange, from, to)` — recent trades.

#### News
12. `newsHeadlineGet(vendorCode, from, to)` — vendor-specific news.
13. `newsHeadlineSubscribe(vendorCode)` — server-side subscription.

#### Reference
14. `securitySearch(query, exchange?)` — symbol search.
15. `securityGet(symbol, exchange?)` — single security metadata.
16. `instrumentSync()` — `securities_c` instrument sync loop.

#### Trading (IOS+)
17. `orderCreate(req: OrderCreateRequest)` — `OrderCreate3`. **Sends `OrderTag` (UUID) for idempotency.**
18. `orderCancel(orderId: number, accountCode?: string)` — `OrderCancel2`.
19. `orderAmend(orderId: number, qty?, price?, tif?)` — `OrderAmend2`.
20. `orderPadGetByAccount(accountCode, filter?)` — `OrderPadGetByAccount`. Filter widened 1-7 after Andre probe 2026-07-27 (env.ts:152-155).
21. `orderStatusGet(orderId: number)` — single-order status.
22. `orderNoGetByOrderTag(orderTag: string)` — recover order from `OrderTag`.

#### Portfolio (IPS — **parked**)
23. `ipsAccountGetAll(accountCode)` — `IPSAccountGetAll1`. Disabled in v2 (`IRESS_ENABLE_IPS=0`).
24. `ipsPositionGetAll(accountCode)` — `IPSPositionGetAll1`. Disabled.
25. `ipsTransactionGetByAccount(accountCode, from, to)` — `IPSTransactionGetByAccount5`. Disabled.

Note: The IPS methods are documented but **not active**. The 23 active methods exclude IPS; the IPS surface is opt-in via `IRESS_ENABLE_IPS=1`.

### Env-driven method selection
- `IRESS_IRESS_METHODS` (allow-list, CSV).
- `IRESS_IOS_METHODS` (allow-list for IOS+ namespace).
- `IRESS_IPS_METHODS` (allow-list for IPS namespace; default empty).
- `IRESS_FIX_METHODS` (allow-list for FIX+; default empty).

---

## 3. Live adapter (`live.ts`)

### SOAP envelope
`wealth-navigator/src/lib/iress/live.ts` is the live SOAP client. Each IRESS V4 service has its own namespace; the client builds envelope headers with `UserName`, `CompanyName`, `ApplicationID`, `Session`, and service-specific `Server` (e.g., `MINT` for IOS+).

### Quote mapping (`mapQuote`, `resolveQuoteLast`)
- **NPN pattern** — NPN sends bare `<Last>`; no `LastPrice`/`PreviousClosePrice`. Adapter preserves raw `Last` and notes the row shape.
- **Standard pattern (AGL/FSR/MTN/SBK)** — `LastPrice`/`PreviousClosePrice` are integer **cents**.
- **BHG pattern** — only `LastPrice` (no `PreviousClosePrice`); adapter treats as stale and **skips write** to `securities_c.last_price` unless `LastPrice` falls within `close ± 5%`. Comment at `live.ts:480-540` documents this fail-closed behaviour.
- Worker `mapQuote` (in `workers/iress-ingest/src/`) uses the same logic for `stock_intraday_c` writes.

### Quote row-shape variance
Per `IRESS_INTEGRATION_AND_SCALE_SAFETY.md:98`: NPN sends bare `<Last>`; AGL/FSR/MTN/SBK/BHG send `LastPrice`/`PreviousClosePrice` integer cents. Worker `mapQuote` validates `Last` against `Close` anchor and skips writes when only stale `LastPrice` is present (BHG pattern).

### OrderCreate3 envelope
- `OrderCreate3` is the IRESS V4 method that submits an order.
- `OrderTag` (UUID) is always sent. Worker always sends one; transport-level failures recover via `OrderNoGetByOrderTag`.
- Dry-run gate: `IRESS_WORKER_DRY_RUN` (default `true`) is a worker-wide flag, but **does not stop live order submission** unless `SUPABASE_ALLOW_WRITES=1` is also flipped off. **Treat dry-run as off when SUPABASE_ALLOW_WRITES=1.** Add an explicit `IRESS_ORDER_EXECUTION_ENABLED` gate (P1.15.5).
- **Per-client guard** — `IRESS_PER_CLIENT_GUARD=1` (default-off) is mandatory for production client orders (`http-api.ts:148-159`).
- **Production-order readiness gate** — `IRESS_PRODUCTION_ORDERS=1` enables `/uat` and `/uat/send-to-market`. The `http-api.ts:127-176` readiness check returns 5 blockers:
  1. `IRESS_PER_CLIENT_GUARD=0`
  2. `IRESS_PRODUCTION_ORDERS=0` (production opt-in missing)
  3. `IRESS_ACCOUNT_CODE` resolves to UAT code
  4. `IRESS_BASE_URL` points to UAT
  5. `IRESS_WORKER_DRY_RUN=true`

### Cancel + amend
- Currently **MOCK client** → `/api/orders/cancel`, `/api/orders/amend`. Worker HTTP API has the routes (`/orders/cancel`, `/orders/amend`) but no live IRESS wiring yet (planned for Phase C2 / C3).

### Session recovery
- **Sticky ApplicationID** — same `(UserName + CompanyName + ApplicationID)` triple recovers the session. Pattern: `Mint-OEMS-<Env>-<Node>-<GUID>`. Persisted in `worker_session_metadata` on the institutional DB.
- Worker startup reads `worker_session_metadata` first to recover the prior session (skipping the seat contention step).
- On first boot (no `worker_session_metadata` row), worker hits first-boot `25008` ("no licenses"). Auto-recovery: `IRESS_FORCE_KICK_ALL=1` kicks any orphan, then re-attempts `IRESSSessionStart`.

### 25008 fault (license seat contention)
- IRESS SOAP fault code 25008 = "no licenses".
- Cause: another IRESS session holds the same `UserName`/`CompanyName`/`ApplicationID`, or the seat is held by an orphan.
- Recovery:
  1. `bun run iress:logout` — explicit `IRESSSessionEnd` (script at `scripts/iress-logout.ts`).
  2. `IRESS_SESSION_NUMBER_TO_KICK=<n>` — numeric seat to evict.
  3. `IRESS_FORCE_KICK_ALL=1` — auto-kick on first-boot 25008. Unset after recovery.
  4. `IRESS_FORCE_ORPHAN_CLEAR=1` — one-shot orphan clearance (polls `IRESSSessionStart` every 3s for up to 60s).
- **`LICENSE_RELEASE_DELAY_MS = 3000`** — wait between `IRESSSessionEnd` and the seat being released.

### 25002 / 25014 / 25015 / 25018 (other common faults)
- **25002** — invalid session. Adapter auto-ends + retries once.
- **25014** — symbol not entitled. Returns `entitlement_blocked` to the BFF.
- **25015** — order limit breached. Adapter maps to `limit_breach`; BFF surfaces as 4xx with reason.
- **25018** — order rejected (pre-trade). Adapter maps to `rejected`; BFF surfaces as 4xx with reason.

### Service session start timeout + retries
- `IRESS_SVC_START_TIMEOUT_MS = 30_000` (live.ts:1011).
- `IRESS_SVC_START_RETRIES = 1`.
- `IRESS_SVC_START_RETRY_DELAY_MS = 1000`.

### Approved-symbols gate (`approved-symbols.ts`)
- **Fail-closed IRESS price gate**: only writes `securities_c.last_price` if the symbol is in the approved set.
- Set is built from `securities_c.symbol` + `JSE_RATE_CODES + FX_RATE_CODES` (e.g. JIBAR_3M, USDZAR).
- New symbols added by `instrumentSync()` automatically enter the gate after the next `securities_c` upsert.
- P1.4 risk: `instrumentSync()` is opt-in via `IRESS_WORKER_INSTRUMENT_SYNC=1`; default-off today.

---

## 4. Mock adapter (`mock.ts`)

- `IressMock` — deterministic in-memory mock adapter. Drives `IRESS_MODE=mock` on Vercel.
- Mock quotes are derived from `mock-quotes.ts` (deterministic seeds).
- Mock orders are recorded in an in-memory log; never persisted to Supabase.
- Used in dev / preview / prod fallback (`isUseSupabaseQuotesEnabled()` defaults true → Supabase, but if unset the adapter stays on mock).

### When the BFF uses mock vs live vs worker
- **`IRESS_MODE=mock`** — adapter returns mock results. **Vercel production posture.**
- **`IRESS_MODE=live`** — adapter makes real SOAP calls. **Railway worker posture.**
- **`USE_SUPABASE_QUOTES=true`** — BFF reads Supabase snapshot instead of calling the adapter. **Vercel production posture.**
- **`USE_SUPABASE_QUOTES=false` + `IRESS_WORKER_URL`** — BFF reverse-proxies the worker's HTTP API. **Path B fallback.**
- The mock + Supabase postures are not mutually exclusive — Path A reads Supabase; Path B reverse-proxies the worker.

---

## 5. Order lifecycle (`oems_order_audit`)

### Schema
`wealth-navigator/supabase/migrations/`:
- `…20260713000001_oems_order_audit_lifecycle_states.sql:11` — added `pending_ack`, `acknowledged`, `working`, `partial`, `filled`, `cancelled`, `expired`, `rejected`, `failed`.
- `…20260714000001_oems_order_audit_cancel_amend_pending.sql:16` — added `cancel_pending`, `ampend_pending`.
- `…20260722000001_oems_order_audit_parked.sql:18` — added `parked`.
- 11 IRESS state values + 2 client pseudo-states (`NOT_SENT`, `MIXED`).

### Full lifecycle
```
created → pending_ack → acknowledged → working → partial → filled
                          │             │      → cancelled → cancel_pending → cancelled
                          │             │      → rejected
                          │             │      → expired
                          │             │      → failed
                          │             └────→ amend_pending → working
                          └──→ parked (post-cutover audit)
```

### Pseudo-states (UI only)
- **`NOT_SENT`** — order row exists in the audit table but `created_at` has no follow-up fill event. Pre-IRESS.
- **`MIXED`** — multiple working states per order row. Pre-IRESS.

### Worker → audit mapping
- Worker `/orders/send-to-market` calls `OrderCreate3` and writes `oems_order_audit` with `status='pending_ack'`.
- Worker `/orders` (Path B passthrough) calls `OrderPadGetByAccount` every `IRESS_WORKER_ORDER_POLL_SEC` (default 60s).
- Each `OrderPadGetByAccount` response updates `oems_order_audit.status` per the IRESS state mapping.

### Recovery (`OrderNoGetByOrderTag`)
- On transport failure after `OrderCreate3` (network drop, worker crash), worker calls `OrderNoGetByOrderTag(orderTag)` to recover the IRESS order number.
- The `OrderTag` is the **idempotency key**. Without it, retries could double-submit.
- Comment at `http-api.ts:104-110`: "We always send one. Always."

### `avgPx` unit ambiguity (P1.15.6)
- IRESS V4 `Order.avgPx` returns the value in **Rands** per the WSDL, but `derivePositions` (positions reconstruction) treats it as **cents** and divides by 100.
- **Pin the SOAP unit of `Order.avgPx` before trusting positions.** Verify against the WSDL `Order` type definition and the IRESS Programmer's Guide. Until pinned, `open_average_price` could be ~100× off if a Rands value reaches `derivePositions`.
- This is the **single biggest functional gap for a retail OEMS** (`IRESS_INTEGRATION_AND_SCALE_SAFETY.md:97-98`).

---

## 6. Workflows (order lifecycle in detail)

### Create → Acknowledge → Working
1. BFF `POST /api/orders/submit` → worker `/orders/send-to-market`.
2. Worker `OrderCreate3` (with `OrderTag` UUID) → `pending_ack`.
3. Worker `OrderPadGetByAccount` poll → `acknowledged` → `working`.
4. Worker `OrderPadGetByAccount` poll → `partial` (if partly filled) → `filled`.

### Cancel
1. BFF `POST /api/orders/cancel` → worker `/orders/cancel` (`OrderCancel2`).
2. `oems_order_audit.status = cancel_pending` (after OrderCancel2 ack) → `cancelled`.

### Amend
1. BFF `POST /api/orders/amend` → worker `/orders/amend` (`OrderAmend2`).
2. `oems_order_audit.status = amend_pending` (after OrderAmend2 ack) → `working` (with new qty/price).

### Reject
1. Adapter maps `OrderCreate3` rejection → `oems_order_audit.status = rejected`.

### Expire
1. Time-in-force expiry (DAY) → `oems_order_audit.status = expired`.

### Failure
1. Adapter / worker write failure → `oems_order_audit.status = failed`.

### `IRESS_IRESS_ORDER_FILTER`
`IRESS_ORDER_FILTER` (default `7`) widens `OrderPadGetByAccount` filter. After Andre probe (2026-07-27), filter widened from 1 to 1-7. Affects which orders the worker sees in the `OrderPadGetByAccount` response.

---

## 7. News vendor (`newsHeadlineGet`)

### Vendor universe
`IRESS_NEWS_VENDOR` (worker env) and `newsVendorCode` (BFF) accept the union documented in `src/lib/iress/client.ts:184-202`:
`SENS | IRESS | Reuters | Bloomberg | Moneyweb | Dow Jones | Business Day`.

Worker defaults: `SENSD` (prod); `SENS` (CT/UAT). BFF `/api/iress/news` defaults `SENS`.

### Vendor fault fallback
Vendor fault triggers a single fallback to `SENSD` (the always-entitled delayed vendor) via `workers/iress-ingest/src/news-ingest.ts::shouldFallbackToSensd()`.

### Production status
- Worker `/debug/news-vendor-probe` is wired and tests vendor entitlement at runtime.
- `IRESS_NEWS_INGEST=1` enables the worker news ingest loop (default opt-in).
- Per-loop dry-run (`IRESS_NEWS_DRY_RUN=true`, default).
- Per-loop writes (`IRESS_NEWS_ALLOW_WRITES=false`, default) — must flip to enable `news_item_c` writes.
- News loop interval: `IRESS_NEWS_INGEST_INTERVAL_SEC` (default 21600s = 6h).
- News max rows: `IRESS_NEWS_MAX_ROWS` (default 2000, floor 500).

### SENS vendor on prod seat
**`SENSD` (SENS NEWS DELAYED) is the only vendor the prod market-data seat is entitled to** (`AGENTS.md:12, 25`). Real-time `SENS` is NOT entitled on the prod seat.

---

## 8. TimeSeriesGet2 (the unblock that worked)

### Working methods (per Andre probe 2026-07-09)
- `TimeSeriesGet2` with `DataSource=zax` + `Exchange=jse` → unblocks ALSI/J203, sector heatmap, ZAR curve.
- `OrderCreate3` → confirmed working (Andre created a test SOL pending order on MINT_CT).

### Entitlement status (per `VENDOR_ENTITLEMENT_STATUS.md`)
- **Working**: `PricingQuoteGet` (12-symbol default), `TimeSeriesGet2(zax, jse)` for J203.
- **Pending entitlement** (vendor outreach needed): sector codes (Tech, Financials, Industrials, Consumer), R-codes (R2030, R2035, R2040), real-rate codes, NewsHeadlineGet (SENS prod), Macro indicators, Fundamentals, Money-market symbols.
- **No V4 method identified**: L2 depth (`OrderBookGet`), time-and-sales, real-time SENS.

### Worker env defaults (`workers/iress-ingest/src/env.ts:333`)
- `IRESS_TIMESERIES_INDEX_DATASOURCE=JSED` (vs `zax` for ALSI).
- `IRESS_TIMESERIES_CURVE_DATASOURCE=JSED`.
- `IRESS_TIMESERIES_INDEX_CODES=J203`.
- `IRESS_TIMESERIES_CURVE_CODES=["R2030","R2035","R2040"]`.
- `IRESS_TIMESERIES_REAL_CODES=[]`.
- `IRESS_TIMESERIES_CURVE_EXCHANGE=AGB`.

---

## 9. Worker passthrough (`worker-api.ts`)

### `callWorker(opts)` (lines 162-233)
- `Authorization: Bearer ${WORKER_HTTP_TOKEN}` attached when set (lines 191-193).
- Surfaces upstream body verbatim up to 16 KB.
- `WORKER_API_TIMEOUT_MS = 10_000` (line 25).

### `resolvedBase()` (lines 77-85)
- Repairs malformed `IRESS_WORKER_URL` (strips stray ` Port 8765`, adds `https://`, removes trailing slash).

### `WorkerApiResult` discriminated union (lines 28-49)
- `not_configured`, `unreachable`, `timeout`, `upstream_error`.

### `streamWorkerSse(opts)` (lines 246-257)
- Returns the URL + `Accept: text/event-stream` headers; returns `null` when unconfigured.

### BFF Path B endpoints
- `/api/orders/live` — worker `/orders`.
- `/api/orders/stream` — worker `/orders/stream` (SSE).
- `/api/integration/health` — worker `/health`.
- `/api/integration/diagnostics` — worker `/debug/ips-session`.
- `POST /api/orders/submit` — worker `/orders/send-to-market`.
- `POST /api/orders/cancel` — worker `/orders/cancel`.
- `POST /api/orders/amend` — worker `/orders/amend`.

---

## 10. Error mapping (`errors.ts`)

### Fault codes
| Code | Meaning | Adapter action | BFF response |
|---|---|---|---|
| 25008 | No licenses (seat contention) | Auto-end + retry once; honor `IRESS_FORCE_KICK_ALL` | 503 seat_unavailable |
| 25002 | Invalid session | Auto-end + retry once | 503 invalid_session |
| 25014 | Symbol not entitled | Map to `entitlement_blocked` | 403 entitlement_blocked |
| 25015 | Order limit breached | Map to `limit_breach` | 422 limit_breach |
| 25018 | Order rejected (pre-trade) | Map to `rejected` | 422 rejected |

### BFF error reasons
- Typed BFF error reasons in `wealth-navigator/src/lib/bff-reasons.ts` (`BffUnavailableReason`).
- Used by `EmptyDataState` to render the right migration / entitlement copy.

---

## 11. IRESS Integration & Scale Safety (`docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`)

The authoritative doc for IRESS-side concerns. Key items:

### Big functional gaps
- **No fills → `stock_holdings_c` bridge** — broker fill price/qty never corrects the client's held quantity or cost basis.
- **Broker fees not wired** — IRESS `BookingGetByOrganisation2` is NOT yet wired. P&L is gross — omits transaction costs; no contract notes, no true cost basis.
- **`avgPx` unit ambiguity** — see Doc 4.5.
- **Client attribution gap** — every order hard-forced to MKT with no price/limit; no per-client reference reaches the broker; `SEND_TO_MARKET` kill-switch incomplete (two routes bypass it); blotter submit lacks admin RBAC.
- **Single license seat** — only the Railway worker may hold the IRESS license; never open competing live IRESS sessions from Vercel, local, or retail app.

### Graceful deploys
- Single replica + 3s license release window.
- 2-replica drain is **NOT safe** today (25008 collision).
- If zero-downtime is needed, design needs license pooling or Redis Stream handoff (`GO_LIVE_RUNBOOK.md:386-389`).

### Vendor entitlement ledger
Per `VENDOR_ENTITLEMENT_STATUS.md`:
- **Working** — `PricingQuoteGet` (12-symbol default), `TimeSeriesGet2(zax, jse)` for J203, `OrderPadGetByAccount`, `OrderCreate3`, `OrderCancel2`, `OrderAmend2`, `NewsHeadlineGet(SENSD)` (UAT only).
- **Pending entitlement** — sector codes, R-codes, real-rate codes, NewsHeadlineGet (SENS prod), Macro indicators, Fundamentals, Money-market symbols.
- **No V4 method identified** — L2 depth (`OrderBookGet`), time-and-sales, real-time SENS.

---

## 12. News Headline wire (`docs/SENS_NEWSHEADLINE_WIRE.md`)

### Vendor surface
- `NewsHeadlineGet(vendorCode, from, to)` returns vendor-specific news.
- Real-time SENS (`SENS`) is only entitled on the **UAT/CT seat**. Production seat is entitled to **`SENSD`** only.
- T5 passthrough: worker reads on demand via Path B (`/api/iress/news` → worker `/debug/news-vendor-probe`); nothing persisted until vendor contract.

### Pilot-write gate
- `IRESS_NEWS_ALLOW_WRITES=false` (default) blocks `news_item_c` writes.
- Per-loop pilot-write gate at `news-ingest.ts::shouldAllowWrite()` lets ops flip writes on for a single symbol universe without touching `IRESS_NEWS_ALLOW_WRITES`.

### 100% real target
- **Now** — Quotes for 10-symbol watchlist (Done).
- **Week 1** — Orders in audit, worker health visible (Done UI; worker writes need `SUPABASE_ALLOW_WRITES=1`).
- **Week 2** — Index + FX + JIBAR on worker watchlist (2-3 days eng, IRESS symbol entitlement).
- **Week 3** — Sector indices + ALSI intraday (3-5 days eng, TimeSeriesGet2 entitlement — now WORKING).
- **Week 4+** — SENS (now wired on prod worker 2026-07-22, vendor catalog + universe tagging in place), news, macro (vendor selection + contract).
- **Week 6+** — AUM/P&L, personas, fundamentals (portfolio system integration).

---

## 13. UAT order pipeline (`docs/UAT_ORDER_PIPELINE.md`)

### Pipeline
- `/api/orders/preflight` (BFF, local) — pre-trade validation. Reads `oems_account_c` cash + position snapshot + in-flight orders from `oems_order_audit`.
- `/api/orders/submit` (BFF) → worker `/uat/send-to-market` when `uatModeEnabled()` else `/orders/send-to-market`.
- Worker `/uat/orders` — UAT-specific order endpoint (gated by `IRESS_UAT_MODE=1`).
- Worker `/uat/execution-stream` — SSE stream of UAT execution events.
- Worker `/uat/status` — UAT order status.

### UAT entitlements
- Account `56378` (strictly isolated, no real client money).
- IOS+ server `MINT_CT`.
- News vendor `SENS` (real-time UAT).
- All UAT paths require `IRESS_UAT_MODE=1`. Toggle requires the operator to flip the env var on the worker and restart.

### Safety gates for prod
1. `IRESS_PRODUCTION_ORDERS=1` — required for `/uat/send-to-market` to land real orders. Default `false`.
2. `IRESS_PER_CLIENT_GUARD=1` — required for production client orders. Default `false`.
3. `IRESS_ACCOUNT_CODE` — must resolve to production account `43448`.
4. `IRESS_BASE_URL` — must point to production URL.
5. `IRESS_WORKER_DRY_RUN` — must be `false` for live orders. **The worker-wide dry-run does NOT block `OrderCreate3`**; the production-order readiness gate checks it as a sanity signal, but the gate does not enforce live order blocking without an explicit `IRESS_ORDER_EXECUTION_ENABLED` flag. **Add this flag** (P1.15.5).

---

## 14. Open gaps in the IRESS integration

### Functional gaps
- **No fills → `stock_holdings_c` bridge** — broker fill price/qty never corrects the client's held quantity or cost basis.
- **Broker fees not wired** — IRESS `BookingGetByOrganisation2` is NOT yet wired.
- **`avgPx` unit ambiguity** — pin the SOAP unit before trusting positions.
- **Client attribution gap** — orders hard-forced to MKT; no per-client reference reaches broker.
- **`SEND_TO_MARKET` kill-switch incomplete** — two routes bypass it.
- **Worker `OrderCreate3` ignores dry-run gates** — need explicit `IRESS_ORDER_EXECUTION_ENABLED`.

### Entitlement gaps
- **Sector codes** — `TimeSeriesGet2` for sectors (Tech, Financials, Industrials, Consumer).
- **Curve codes** — `TimeSeriesGet2` for R-codes (R2030, R2035, R2040).
- **Real-rate codes** — `TimeSeriesGet2` for inflation-linked bonds.
- **NewsHeadlineGet (SENS prod)** — only SENSD entitled on prod seat.
- **Macro indicators** — vendor pending.
- **Fundamentals** — vendor pending.
- **Money-market symbols** — symbol entitlement pending.

### Method gaps
- **L2 depth** — `OrderBookGet` not identified.
- **Time-and-sales** — no V4 method.

### Operational gaps
- **Single replica** — license seat contention risk.
- **No license pooling** — Redis Stream handoff not built.
- **Production-order readiness gate sanity only** — does not block live orders without explicit flag.
- **Per-client attribution** — orders hard-forced to MKT with no client reference.

---

*This doc is the IRESS adapter deep-dive. Pair with Doc 5 (Railway worker) for the ingest side, Doc 9 (API surface) for the BFF contracts, and Doc 11 (deployment) for the cutover playbook.*
