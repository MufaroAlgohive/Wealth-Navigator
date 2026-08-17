# Wealth Navigator — Railway IRESS Worker (`workers/iress-ingest`)

**Audience:** devs, on-call, ops.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/workers/iress-ingest/`, `wealth-navigator/docs/GO_LIVE_RUNBOOK.md`, `wealth-navigator/docs/UAT_ORDER_PIPELINE.md`, `wealth-navigator/docs/SENS_NEWSHEADLINE_WIRE.md`, `wealth-navigator/docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md`, `wealth-navigator/docs/ISSUES_LOG.md`.

> **Correction vs older handoffs:** Confirmed dual Dockerfile / entry-point model: `main.ts` for **UAT**, `main-prod.ts` for **PROD**. Single replica per worker (multi-replica would 25008-collide).

---

## 1. Worker purpose

The Railway IRESS worker is the **only process that may hold the IRESS license seat**. It is the ingest engine that:

1. Holds the single IRESS V4 license seat (no second session, no second replica, no local).
2. Runs **seven concurrent loops** that poll IRESS and write to Supabase:
   - Quote sync (`stock_intraday_c`, `securities_c`)
   - Order pad poll (`oems_order_audit`)
   - TimeSeries (`index_intraday_c`, `yield_curve_history_c`, `oems_curve_metric_c`)
   - News (`news_item_c`) — opt-in
   - Index intraday
   - Curve sync
   - Heartbeat (`integration_worker_health`)
3. Exposes an **HTTP API** on port `8765` that the Vercel BFF reverse-proxies for live / ephemeral data.
4. Persists its IRESS `ApplicationID` in `worker_session_metadata` for restart safety.

**Production posture (2026-07-23 cutover):**
- Worker service: `Iress-Worker-PROD` on Railway.
- Public domain: `https://iress-worker-production.up.railway.app`.
- Single replica (multi-replica = 25008 collision).
- `IRESS_MODE=live` against `webservices.iress.co.za/v4`.
- Account `43448`, IOS+ server `MINT`, news vendor `SENSD`.

**Vercel posture:**
- `IRESS_MODE=mock` (never opens a live IRESS session from Vercel).
- `USE_SUPABASE_QUOTES=true` (Path A — reads from Supabase).
- Path B reverse-proxies the worker's HTTP API.

---

## 2. Directory layout

```
workers/iress-ingest/
├── Dockerfile                      # Oven/bun:1.1 image; copies src + .env.example
├── package.json                    # Bun; bun:1.1
├── tsconfig.json
├── bun.lock
├── .env.example
├── README.md
├── docs/
│   ├── LOOP_HARNESS.md
│   ├── PRODUCTION_READINESS.md
│   ├── WORKER_HTTP_API.md
│   └── ENTITLEMENT_DIAGNOSTICS.md
├── scripts/
│   ├── doctor.ts
│   ├── entitlement-probe.ts
│   ├── 25008-recovery.ts
│   └── …
├── seeds/
│   └── …
└── src/
    ├── main.ts                     # UAT entry point
    ├── main-prod.ts                # PROD entry point (refuses webservices-ct.*)
    ├── env.ts                      # Env parsing + validation (per-env defaults)
    ├── session.ts                  # IRESS session lifecycle
    ├── mapQuote.ts                 # Quote row-shape mapping (BHG pattern, etc.)
    ├── news-ingest.ts              # NewsHeadlineGet ingest loop + vendor fallback
    ├── order-poll.ts               # OrderPadGetByAccount poll
    ├── timeSeries.ts               # TimeSeriesGet2 ingest (indexes, curves, real)
    ├── index-intraday.ts           # J203 ALSI intraday loop
    ├── curve.ts                    # ZAR NSS curve sync
    ├── market-data.ts              # Single-seat market-data session (prod)
    ├── uat-market-data.ts          # UAT market-data session
    ├── http-api.ts                 # Bun HTTP server on port 8765
    ├── recovery.ts                 # 25008 / orphan-clearing logic
    ├── instrumentSync.ts           # securities_c instrument sync
    ├── heartbeats.ts               # integration_worker_health
    ├── retail-sync.ts              # RETAIL price sync (opt-in via IRESS_RETAIL_INGEST)
    ├── alerts.ts                   # Trigger evaluator
    ├── alerts-config.ts
    ├── orders.ts                   # Order create / cancel / amend helpers (worker side)
    ├── positions.ts                # Position reconstruction (from IPS + OrderTag fills)
    ├── bookings.ts                 # BookingGetByOrganisation2 (NOT YET WIRED)
    ├── settlement.ts               # RETAIL_SETTLEMENT_ENABLED
    ├── perClientGuard.ts           # IRESS_PER_CLIENT_GUARD
    ├── supabase.ts                 # Two-client split (institutional + retail)
    ├── reconciliation.ts           # Position reconciliation
    ├── production-readiness.ts     # 5-blocker readiness gate
    ├── news-vendor-probe.ts        # T5 passthrough helper
    ├── loopHarness.ts              # Common loop runner
    ├── diag.ts                     # Diag helpers
    ├── derivePositions.ts          # Position reconstruction
    ├── orderTag.ts                 # OrderTag UUID mint + recovery
    ├── market-data-config.ts
    ├── debug/
    │   ├── ips-session.ts          # /debug/ips-session
    │   ├── soap-raw.ts             # /debug/soap-raw (mutations opt-in)
    │   └── news-vendor-probe.ts    # /debug/news-vendor-probe
    └── util/
        └── …
```

---

## 3. Dual entry-point model

### `main.ts` (UAT)
- Default Worker ID: `iress-ingest-1`.
- Defaults: `IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4`, `IRESS_IOS_SERVER=MINT_CT`, `IRESS_NEWS_VENDOR=SENS`, `IRESS_ACCOUNT_CODE=56378`.
- Boots the 7 concurrent loops and the HTTP API on port `8765`.
- Used for UAT and CT testing.

### `main-prod.ts` (PROD)
- Default Worker ID: `iress-ingest-prod-1`.
- Defaults: `IRESS_BASE_URL=https://webservices.iress.co.za/v4`, `IRESS_IOS_SERVER=MINT`, `IRESS_NEWS_VENDOR=SENSD`, `IRESS_ACCOUNT_CODE=43448`.
- Refuses `webservices-ct.*` as the base URL (`main-prod.ts:18`).
- Boots the 7 concurrent loops + the HTTP API.
- **Single replica** — multi-replica drains 25008-collide.

### Common startup
1. Parse + validate env (`src/env.ts:1-380`).
2. Open IRESS session via `ServiceSessionStart("IOS")`.
3. Apply sticky `ApplicationID` from `worker_session_metadata`.
4. Start the 7 loops + HTTP API.
5. SIGINT / SIGTERM handler releases the session (unless `IRESS_SHUTDOWN_HOOKS=0`).
6. `LICENSE_RELEASE_DELAY_MS = 3000` — wait between `IRESSSessionEnd` and seat release.

---

## 4. Env contract (worker)

### Per-env defaults
Per `workers/iress-ingest/src/env.ts`:
- **UAT** — `IRESS_ACCOUNT_CODE=56378`, `IRESS_IOS_SERVER=MINT_CT`, `IRESS_NEWS_VENDOR=SENS`, `IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4`, `WORKER_ID=iress-ingest-1`.
- **PROD** — `IRESS_ACCOUNT_CODE=43448`, `IRESS_IOS_SERVER=MINT`, `IRESS_NEWS_VENDOR=SENSD`, `IRESS_BASE_URL=https://webservices.iress.co.za/v4`, `WORKER_ID=iress-ingest-prod-1`.

### IRESS-side
| Var | Default (worker) | Required | Behaviour |
|---|---|---|---|
| `IRESS_MODE` | unset (=> `live` for worker; `mock` for BFF) | Yes (worker live) | Drives IressClient selection. |
| `IRESS_BASE_URL` | `webservices.iress.co.za/v4` (prod) / `webservices-ct.iress.co.za/v4` (UAT) | Yes | SOAP endpoint. `main-prod.ts` refuses `webservices-ct.*`. |
| `IRESS_PROD_URL` | `webservices.iress.co.za/v4` | Optional | Dedicated prod market-data endpoint. |
| `IRESS_USERNAME` | empty | Yes (worker live) | SOAP login. |
| `IRESS_PASSWORD` | empty | Yes (worker live) | Same. |
| `IRESS_COMPANY_NAME` | `Mint` (when `@` in username) | Yes | `src/lib/iress/config.ts:21-39`. |
| `IRESS_PROD_USERNAME` / `IRESS_PROD_PASSWORD` / `IRESS_PROD_COMPANY_NAME` | empty | Optional override | `config.ts:66-77`. |
| `IRESS_ACCOUNT_CODE` | `43448` (prod) / `56378` (UAT) | **Yes at runtime** for production | Missing → 503 `account_not_configured` on `/orders`, `/uat/send-to-market`. |
| `IRESS_UAT_ACCOUNT_CODE` | falls back to `IRESS_ACCOUNT_CODE` | Required when `IRESS_UAT_MODE=1` | MUST differ from `IRESS_ACCOUNT_CODE`. |
| `IRESS_UAT_MODE` | `false` | Opt-in | Toggles UAT lane. |
| `IRESS_UAT_ORDER_POLL_SEC` | `30` (floor 5) | Optional | UAT order poll cadence. |
| `IRESS_DEFAULT_EXCHANGE` | `JSE` | Optional | Default exchange for `PricingQuoteGet`. |
| `IRESS_FX_EXCHANGE` | `FX` | Optional | FX rate-code exchange. |
| `IRESS_MM_EXCHANGE` | `MM` | Optional | Money-market exchange. |
| `IRESS_IOS_SERVER` | `MINT` (prod) / `MINT_CT` (UAT) | Optional | `Server` arg for `ServiceSessionStart`. |
| `IRESS_IPS_SERVER` | `IPSAPI` | Optional | IPS service. |
| `IRESS_FIX_SERVER` | `FIXPLUSAPI` | Optional | FIX+ service. |
| `IRESS_ENABLE_IPS` | `0` | Opt-in | Re-enable parked IPS loop. |
| `IRESS_ENABLE_FIX` | `0` | Opt-in | Re-enable parked FIX+ loop. |
| `IRESS_ORDER_FILTER` | `7` | Optional | `OrderPadGetByAccount` filter (widened 1-7 after Andre probe 2026-07-27). |
| `IRESS_IRESS_METHODS` / `IRESS_IOS_METHODS` / `IRESS_IPS_METHODS` / `IRESS_FIX_METHODS` | empty | Optional | Allow-list per namespace. |
| `IRESS_SVC_START_TIMEOUT_MS` | `30_000` | Optional | `ServiceSessionStart` timeout. |
| `IRESS_SVC_START_RETRIES` | `1` | Optional | Retry attempts. |
| `IRESS_SVC_START_RETRY_DELAY_MS` | `1000` | Optional | Backoff. |
| `IRESS_QUOTE_RAW_LOG` | unset | Optional | Dumps raw quote rows. |
| `IRESS_TS_DATASOURCE` | `zax` | Optional | `TimeSeriesGet2` `DataSource`. |
| `IRESS_SESSION_NUMBER_TO_KICK` | unset | Recovery | Numeric seat to evict on `25008`. |
| `IRESS_FORCE_KICK_ALL` | `0` | Recovery | Auto-kick on first-boot 25008. Unset after. |
| `IRESS_FORCE_ORPHAN_CLEAR` | `0` | Recovery | One-shot orphan clearance. |
| `IRESS_SHUTDOWN_HOOKS` | `0` | Optional | Disable SIGINT/SIGTERM release. |
| `IRESS_WATCHLIST_SYMBOLS` | empty → default 12-symbol list from `JSE_TRACKED_UNIVERSE + JSE_RATE_CODES` | Optional | Comma-separated override. |
| `IRESS_WATCHLIST_EXCHANGES` | `{}` | Optional | `SYM=EXCHANGE` per-symbol map. |
| `IRESS_WORKER_DRY_RUN` | `true` (safe default) | Optional | Worker-wide dry-run. **Does NOT block `OrderCreate3`**. |
| `SUPABASE_ALLOW_WRITES` | `false` (safe default) | Optional | Worker-wide DB writes. |
| `IRESS_WORKER_HEARTBEAT_SEC` | `30` (floor 5) | Optional | Heartbeat loop cadence. |
| `IRESS_WORKER_QUOTE_INTERVAL_SEC` | `15` (floor 5) | Optional | Quote sync cadence. |
| `IRESS_WORKER_ORDER_POLL_SEC` | `60` (disable when ≤0) | Optional | Order-pad poll cadence. |
| `IRESS_WORKER_TIMESERIES_INTERVAL_SEC` | `300` | Optional | TimeSeries loop. |
| `IRESS_WORKER_INDEX_INTRADAY_INTERVAL_SEC` | `120` | Optional | Index intraday loop. |
| `IRESS_WORKER_INSTRUMENT_SYNC` | `false` | Opt-in | Enables `securities_c` instrument sync loop. |
| `IRESS_ALERT_EVAL_SEC` | `60` (floor 15) | Optional | Trigger evaluator cadence. |
| `IRESS_PRODUCTION_ORDERS` | `false` | **Opt-in prod gate** | Shared gate for `/uat/send-to-market`. |
| `IRESS_PER_CLIENT_GUARD` | `0` | **Mandatory for production client orders** | Toggles client-order pre-trade guard. |
| `IRESS_BUY_GUARD_CAP_RANDS` | `NaN` → no cap | Optional | Max buy cap. |
| `IRESS_MARKET_BUY_BUFFER` | `1.02` | Optional | Buffer multiplier for buy guard. |
| `IRESS_DESTINATION` / `IRESS_PRODUCTION_DESTINATION` | `LONGMARK CARE` | Optional | IOS+ destination free-text. |
| `IRESS_PRICE_OVERLAY` | unset | UAT override | `=0` makes Yahoo own `last_price`. |
| `IRESS_RETAIL_INGEST` | `false` | Opt-in | Enables full-universe retail price loop. |
| `IRESS_RETAIL_DRY_RUN` | `true` | Optional | Retail-ingest dry-run. |
| `RETAIL_SETTLEMENT_ENABLED` | `false` | **Opt-in settlement** | Only path that moves client money. |
| `RETAIL_SETTLEMENT_DRY_RUN` | `true` | Optional | Logs wallet/lot deltas without persisting. |
| `RETAIL_PRICE_SOURCE_COL` | unset | Optional | When `1`, stamps `price_source` on retail writes. |
| `RETAIL_SCALE_REF_COL` | unset | Optional | Read `scale_ref_cents` column (review-only). |
| `IRESS_NEWS_INGEST` | unset | Opt-in | Enables news ingest loop. |
| `IRESS_NEWS_DRY_RUN` | `true` | Opt-in | Per-loop news dry-run. |
| `IRESS_NEWS_ALLOW_WRITES` | `false` | Opt-in | Per-loop news writes to `news_item_c`. |
| `IRESS_NEWS_VENDOR` / `newsVendorCode` | `SENSD` (prod); `SENS` (CT/UAT) | Optional | Vendor code for `NewsHeadlineGet`. |
| `IRESS_NEWS_MAX_ROWS` | `2000` (floor 500) | Optional | Per-loop row cap. |
| `IRESS_NEWS_INGEST_INTERVAL_SEC` | `21600` (6h, floor 300) | Optional | News loop interval. |
| `IRESS_USE_SINGLE_SEAT` | `1` | Default | Legacy knob — single-seat is the only shape. |
| `IRESS_MARKET_DATA_PROD` | `1` (post-cutover) | Back-compat | Legacy dual-session flag removed. |
| `IRESS_MARKETDATA_BASE_URL` | `iressConfig.prodUrl` | Optional | Prod market-data endpoint. |
| `IRESS_TIMESERIES_INDEX_CODES` | `J203` | Optional | Index codes. |
| `IRESS_TIMESERIES_SECTOR_CODES` | `[]` | Optional | Sector codes. |
| `IRESS_TIMESERIES_CURVE_CODES` | `["R2030","R2035","R2040"]` | Optional | Curve codes. |
| `IRESS_TIMESERIES_REAL_CODES` | `[]` | Optional | Real-rate codes. |
| `IRESS_TIMESERIES_CURVE_EXCHANGE` | `AGB` | Optional | Curve exchange. |
| `IRESS_TIMESERIES_CURVE_DATASOURCE` | `JSED` | Optional | Curve data source. |
| `IRESS_TIMESERIES_INDEX_DATASOURCE` | `JSED` | Optional | Index data source. |
| `IRESS_HOT_PRICE_INTERVAL_SEC` | `0` (off) | Optional | Hot symbol sub-loop. |
| `IRESS_DEBUG_ORDERS_PROBE` | unset | Optional | One-shot orders-entitlement probe (can evict market-data session if not disabled). |
| `IRESS_ALLOW_MUTATIONS` | `0` (blocked) | Optional | Allow `/debug/soap-raw` mutating methods. |
| `IRESS_STALE_FALLBACK_HOURS` | `3` | Optional | Yahoo takes over after this many hours without IRESS update. |

### Worker HTTP API
| Var | Default | Required | Behaviour |
|---|---|---|---|
| `WORKER_HTTP_PORT` | `8765` | Optional | Local port. Railway sets `PORT` automatically. |
| `WORKER_HTTP_HOST` | `0.0.0.0` | Optional | Bind host. |
| `WORKER_HTTP_DISABLED` | unset (= on) | Optional | Kill switch. |
| `WORKER_HTTP_TOKEN` | unset (= auth off) | Opt-in pair | Shared bearer; both sides opt in. |
| `WORKER_REQUIRE_HTTP_TOKEN` | unset (off) | Opt-in | Enforce bearer on worker. |
| `WORKER_ID` | `iress-ingest-1` (UAT) / `iress-ingest-prod-1` (prod) | Yes | `worker_session_metadata.worker_id` PK. |
| `PORT` (Railway auto) | Railway-injected | — | Railway's port is honoured before `WORKER_HTTP_PORT`. |
| `RAILWAY_SERVICE_URL` | Railway-injected (auto for Vercel) | Optional | Fallback for `IRESS_WORKER_URL` on Vercel. |
| `RAILWAY_DEPLOYMENT_ID` / `RAILWAY_SERVICE_NAME` | Railway-injected | — | Build `ApplicationID` + logging identity. |
| `RAILWAY_REPLICA_ID` | unset | Optional | Stable per-replica ID for `ApplicationID`. |
| `NEWS_PROBE_MIN_GAP_MS` | `10000` | Optional | Throttle for `/debug/news-vendor-probe`. |

### Supabase
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (legacy shared).
- `INSTITUTIONAL_SUPABASE_URL` / `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` (required; falls back to shared).
- `RETAIL_SUPABASE_URL` / `RETAIL_SUPABASE_SERVICE_ROLE_KEY` (required for retail ingest; falls back to shared).
- `STAGING_SUPABASE_*` (when split).
- Behaviour when missing: worker logs `CONFIG: ... NOT SET ...` warnings (`main.ts:546, 559`); relevant loops skip work.

---

## 5. The seven loops

### Loop 1 — Quote sync (`mapQuote.ts`)
- Default interval: `IRESS_WORKER_QUOTE_INTERVAL_SEC` (default 15s).
- Reads `IRESS_WATCHLIST_SYMBOLS` (default 12 symbols: JSE_TRACKED_UNIVERSE + JSE_RATE_CODES).
- For each symbol: `PricingQuoteGet` → `mapQuote` → `resolveQuoteLast` → upsert `stock_intraday_c` + `securities_c`.
- **BHG pattern** — only `LastPrice` (no `PreviousClosePrice`); adapter treats as stale and **skips write** unless `LastPrice` falls within `close ± 5%`.
- **Standard pattern** — AGL/FSR/MTN/SBK use `LastPrice`/`PreviousClosePrice` integer cents.
- **NPN pattern** — bare `<Last>`; preserved.
- **Approved-symbols gate** (`approved-symbols.ts`) — only writes if symbol is in the approved set (built from `securities_c.symbol` + JSE_RATE_CODES + FX_RATE_CODES).

### Loop 2 — Order pad poll (`order-poll.ts`)
- Default interval: `IRESS_WORKER_ORDER_POLL_SEC` (default 60s).
- Calls `OrderPadGetByAccount` with `IRESS_ORDER_FILTER` (default `7`).
- Updates `oems_order_audit.status` per IRESS state mapping.
- T0 mappings: pending_ack, acknowledged, working, partial, filled, cancelled, cancel_pending, amend_pending, expired, rejected, failed.
- If `IRESS_WORKER_ORDER_POLL_SEC <= 0`, loop is disabled.

### Loop 3 — TimeSeries (`timeSeries.ts`)
- Default interval: `IRESS_WORKER_TIMESERIES_INTERVAL_SEC` (default 300s).
- Calls `TimeSeriesGet2` with `IRESS_TS_DATASOURCE` (default `zax`) and per-code exchange (default `jse`).
- Writes `index_intraday_c`, `yield_curve_history_c`, `oems_curve_metric_c`, sector series.
- Working: ALSI/J203 (zax+jse).
- Pending entitlement: sector codes, R-codes (R2030/R2035/R2040), real-rate codes.

### Loop 4 — News ingest (`news-ingest.ts`)
- Default interval: `IRESS_NEWS_INGEST_INTERVAL_SEC` (default 21600s = 6h, floor 300s).
- Reads `IRESS_NEWS_VENDOR` (default `SENSD` prod / `SENS` CT/UAT).
- Calls `NewsHeadlineGet`.
- Per-loop dry-run (`IRESS_NEWS_DRY_RUN`, default true).
- Per-loop writes (`IRESS_NEWS_ALLOW_WRITES`, default false) — must flip to enable `news_item_c` writes.
- Per-loop pilot-write gate at `news-ingest.ts::shouldAllowWrite()`.
- Vendor fault fallback: `shouldFallbackToSensd()` → single fallback to `SENSD`.
- `IRESS_NEWS_MAX_ROWS` per-loop cap (default 2000, floor 500).

### Loop 5 — Index intraday (`index-intraday.ts`)
- Default interval: `IRESS_WORKER_INDEX_INTRADAY_INTERVAL_SEC` (default 120s).
- Calls `TimeSeriesGet2` for `IRESS_TIMESERIES_INDEX_CODES` (default `J203`).
- Writes `index_intraday_c`.

### Loop 6 — Curve sync (`curve.ts`)
- Default interval: aligned with TimeSeries loop (300s).
- Calls `TimeSeriesGet2` for `IRESS_TIMESERIES_CURVE_CODES` (default `["R2030","R2035","R2040"]`) + real-rate codes (`IRESS_TIMESERIES_REAL_CODES` default `[]`).
- Writes `yield_curve_history_c`, `oems_curve_metric_c` (NSS-fit metrics, KRD, convexity).

### Loop 7 — Heartbeat (`heartbeats.ts`)
- Default interval: `IRESS_WORKER_HEARTBEAT_SEC` (default 30s, floor 5s).
- Writes `integration_worker_health` row with worker ID + status + last-seen.
- Used by `/api/worker-health` BFF endpoint and `/oems/integration` page.

### Other loops (opt-in)
- **Instrument sync** (`instrumentSync.ts`) — `IRESS_WORKER_INSTRUMENT_SYNC=true` enables `securities_c` instrument sync.
- **Retail sync** (`retail-sync.ts`) — `IRESS_RETAIL_INGEST=1` enables full-universe retail price loop.
- **Alerts** (`alerts.ts`) — `IRESS_ALERT_EVAL_SEC` cadence (default 60s, floor 15s).
- **Settlement** (`settlement.ts`) — `RETAIL_SETTLEMENT_ENABLED=1` enables client money moves.
- **Reconciliation** (`reconciliation.ts`) — `/api/cron/position-reconciliation` cron daily 15:30 UTC.

---

## 6. HTTP API (`http-api.ts`)

### Local binding
- Port `8765` (or Railway `PORT` if injected).
- Host `0.0.0.0`.
- `WORKER_HTTP_DISABLED=1` → kill switch.

### Endpoints
- `GET /health` — adapter liveness + entitlement check (calls `NewsHeadlineGet` vendor probe + reads `worker_session_metadata`).
- `GET /version` — worker version + `WORKER_ID` + uptime.
- `GET /orders` — `OrderPadGetByAccount` (Path B passthrough).
- `GET /orders/stream` — SSE stream of `/orders` updates.
- `POST /orders/send-to-market` — `OrderCreate3` wrapper. Sends `OrderTag` UUID. Validates production-order readiness gate.
- `POST /orders/cancel` — `OrderCancel2`.
- `POST /orders/amend` — `OrderAmend2`.
- `POST /orders/recover-by-ordertag` — `OrderNoGetByOrderTag(orderTag)`.
- `GET /debug/ips-session` — IPS session introspection (parked).
- `POST /debug/soap-raw` — raw SOAP call (mutating methods blocked unless `IRESS_ALLOW_MUTATIONS=1`).
- `GET /debug/news-vendor-probe` — vendor entitlement probe (T5 passthrough).
- `GET /uat/orders` — UAT order endpoint (gated by `IRESS_UAT_MODE=1`).
- `POST /uat/send-to-market` — UAT `OrderCreate3` wrapper.
- `GET /uat/execution-stream` — SSE stream of UAT execution events.
- `GET /uat/status` — UAT order status.

### Production-order readiness gate (`production-readiness.ts`, `http-api.ts:127-176`)
The `POST /uat/send-to-market` and `POST /orders/send-to-market` paths check 5 blockers:
1. `IRESS_PER_CLIENT_GUARD=0`
2. `IRESS_PRODUCTION_ORDERS=0` (production opt-in missing)
3. `IRESS_ACCOUNT_CODE` resolves to UAT code
4. `IRESS_BASE_URL` points to UAT
5. `IRESS_WORKER_DRY_RUN=true`

**The gate is a sanity signal, not a hard block** (because `IRESS_WORKER_DRY_RUN` does NOT block `OrderCreate3`). The real live-order blocking needs an explicit `IRESS_ORDER_EXECUTION_ENABLED` flag (P1.15.5).

### Bearer token
- `WORKER_HTTP_TOKEN` shared with Vercel BFF.
- `Authorization: Bearer ${WORKER_HTTP_TOKEN}` attached by BFF.
- `WORKER_REQUIRE_HTTP_TOKEN=1` enforces the bearer check on the worker.
- `WORKER_HTTP_TOKEN` literal is checked into `ISSUES_LOG.md:0.5.4.a` and needs rotation.

---

## 7. Session management (`session.ts`)

### Sticky ApplicationID
- Pattern: `Mint-OEMS-<Env>-<Node>-<GUID>`.
- Persisted in `worker_session_metadata` on the institutional DB, keyed by `worker_id`.
- Worker startup reads `worker_session_metadata` first to recover the prior session.
- Same `(UserName + CompanyName + ApplicationID)` triple recovers the session.

### Session lifecycle
1. `ServiceSessionStart("IOS")` with `UserName`, `CompanyName`, `ApplicationID`, `Server=MINT` (or `MINT_CT`).
2. Recovered session stored in `worker_session_metadata.iress_session_key`.
3. On each restart, recover session first; only mint a new `ApplicationID` if no prior row exists.
4. SIGINT / SIGTERM handler calls `IRESSSessionEnd` (unless `IRESS_SHUTDOWN_HOOKS=0`).
5. `LICENSE_RELEASE_DELAY_MS = 3000` — wait between `IRESSSessionEnd` and seat release.

### 25008 recovery (`recovery.ts`)
- First-boot 25008: `IRESS_FORCE_KICK_ALL=1` kicks any orphan + retries `IRESSSessionStart`.
- Persistent 25008: `IRESS_SESSION_NUMBER_TO_KICK=<n>` evicts a specific seat.
- Orphan-clear: `IRESS_FORCE_ORPHAN_CLEAR=1` polls `IRESSSessionStart` every 3s for up to 60s.
- Manual: `bun run iress:logout` (script at `scripts/iress-logout.ts`).

---

## 8. Supabase client split (`supabase.ts`)

### `createInstitutionalSupabase(env)` → `nnwz…`
- For: `oems_order_audit`, `oems_position_c`, `oems_transaction_c`, `oems_account_c`, `worker_session_metadata`, `integration_worker_health`, `oems_curve_metric_c`, `yield_curve_history_c`, `index_intraday_c`, `news_item_c`, `iress_price_validation_c`, model tables, IC tables.

### `createRetailSupabase(env)` → `mfxng…`
- For: `securities_c`, `stock_intraday_c` (price sync only).
- Dormant unless `IRESS_RETAIL_INGEST=1` AND `RETAIL_SUPABASE_URL` set.
- `IRESS_RETAIL_DRY_RUN=true` by default — logs without writing.

### Fallback behaviour
- `INSTITUTIONAL_SUPABASE_*` falls back to `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (legacy shared).
- `RETAIL_SUPABASE_*` falls back to shared.
- Behaviour when missing: worker logs `CONFIG: ... NOT SET ...` warnings; relevant loops skip work.

---

## 9. Order pipeline

### `POST /orders/send-to-market` flow
1. BFF → worker `/orders/send-to-market` with `{ symbol, side, quantity, account_code?, order_tag? }`.
2. Worker validates production-order readiness gate (5 blockers).
3. Worker calls `IressClient.orderCreate({ ... })` with `OrderTag` (UUID).
4. Worker writes `oems_order_audit` row with `status='pending_ack'`.
5. Worker `/orders` poll updates `oems_order_audit.status` as IRESS reports.

### `POST /orders/cancel`
1. BFF → worker `/orders/cancel` with `{ order_id, account_code? }`.
2. Worker calls `IressClient.orderCancel(orderId, accountCode)`.
3. Worker updates `oems_order_audit.status = 'cancel_pending'`.
4. Worker `/orders` poll confirms `cancelled`.

### `POST /orders/amend`
1. BFF → worker `/orders/amend` with `{ order_id, qty?, price?, tif? }`.
2. Worker calls `IressClient.orderAmend(orderId, qty, price, tif)`.
3. Worker updates `oems_order_audit.status = 'amend_pending'`.
4. Worker `/orders` poll confirms `working` (with new qty/price).

### `OrderTag` recovery (`orderTag.ts`)
- Mint UUID on `OrderCreate3`. Always send one. Always.
- Recovery on transport failure: `OrderNoGetByOrderTag(orderTag)`.
- Comment at `http-api.ts:104-110`: "We always send one. Always."

### Per-client guard (`perClientGuard.ts`)
- `IRESS_PER_CLIENT_GUARD=1` (default-off) is mandatory for production client orders.
- Validates client SELL orders against the client's actual positions (not desk omnibus).
- Reads RETAIL Supabase per-client ledger.
- Dormant unless `IRESS_PER_CLIENT_GUARD=1` AND `RETAIL_SUPABASE_URL` set.

### Settlement (`settlement.ts`)
- `RETAIL_SETTLEMENT_ENABLED=1` (default-off) is the **only path that moves client money**.
- `RETAIL_SETTLEMENT_DRY_RUN=true` (default) logs wallet/lot deltas without persisting.
- Currently MOCK-ONLY — broker fill pipeline is not wired.

---

## 10. News ingest (`news-ingest.ts`)

### Per-loop pilot-write gate
- `IRESS_NEWS_ALLOW_WRITES=false` (default) blocks `news_item_c` writes globally.
- `shouldAllowWrite()` lets ops flip writes on for a single symbol universe without touching `IRESS_NEWS_ALLOW_WRITES`.

### Vendor fault fallback
- `shouldFallbackToSensd()` → single fallback to `SENSD` (the always-entitled delayed vendor).

### News loop interval
- `IRESS_NEWS_INGEST_INTERVAL_SEC` (default 21600s = 6h, floor 300s).
- `IRESS_NEWS_MAX_ROWS` per-loop cap (default 2000, floor 500).

### T5 passthrough (no persistence)
- Worker reads on demand via Path B (`/api/iress/news` → worker `/debug/news-vendor-probe`); nothing persisted until vendor contract.
- `NEWS_PROBE_MIN_GAP_MS=10000` throttles the probe.

---

## 11. Settlement (`settlement.ts`)

### Status
- **MOCK-ONLY** today.
- `RETAIL_SETTLEMENT_ENABLED=1` is the opt-in gate.
- `RETAIL_SETTLEMENT_DRY_RUN=true` (default) logs wallet/lot deltas without persisting.

### Blockers
- **Broker fill pipeline** (C4) is mock-only. No fills → `stock_holdings_c` bridge yet (`workers/broker-ingest/`).
- **No broker fees wired** — IRESS `BookingGetByOrganisation2` not yet wired.
- **`avgPx` unit ambiguity** — UAT poller stores `avgPx` in Rands but `derivePositions` treats it as cents.

### What settlement would do (when wired)
1. Worker `OrderPadGetByAccount` polls → `oems_order_audit.status = 'filled'`.
2. Settlement writes `stock_holdings_c` updates (price/qty/cost basis).
3. Settlement writes `wallets.balance` updates (cash flow).
4. Settlement writes `transactions` audit.

---

## 12. Position reconciliation (`reconciliation.ts`)

- Daily cron at 15:30 UTC (`/api/cron/position-reconciliation`).
- Compares `oems_position_c` (IRESS-derived) vs `stock_holdings_c` (RETAIL book).
- Surfaces discrepancies as alerts.
- `derivePositions.ts` reconstructs positions from IPS + OrderTag fills.

---

## 13. Production readiness (`production-readiness.ts`, `docs/PRODUCTION_READINESS.md`)

### Five-blocker readiness gate
1. `IRESS_PER_CLIENT_GUARD=0`
2. `IRESS_PRODUCTION_ORDERS=0`
3. `IRESS_ACCOUNT_CODE` resolves to UAT code
4. `IRESS_BASE_URL` points to UAT
5. `IRESS_WORKER_DRY_RUN=true`

### Order dry-run is leaky
- `IRESS_WORKER_DRY_RUN=true` (default) is a worker-wide flag.
- **It does NOT block `OrderCreate3`** — the dry-run only short-circuits DB writes (`SUPABASE_ALLOW_WRITES=false` default).
- The production-order readiness gate is a sanity signal only.
- **Add explicit `IRESS_ORDER_EXECUTION_ENABLED` flag** (P1.15.5).

### What worker `OrderCreate3` ignores
- Ignores `IRESS_WORKER_DRY_RUN` for live order execution (only blocks Supabase writes).
- Ignores `SUPABASE_ALLOW_WRITES` for live order execution.
- Needs explicit `IRESS_ORDER_EXECUTION_ENABLED` gate.

---

## 14. Operational post-cuto

### Per `docs/ISSUES_LOG.md` (post-cutover operating reality)
- `0.5.4.a` — `WORKER_HTTP_TOKEN` literal checked into the doc; needs rotation.
- `0.5.4.b` — Railway GitHub app integration missing initially (manual install via `https://railway.com/account/integrations`).
- `0.5.4.c` — 9 unpushed commits on `main` (risk for redeploy).
- `0.5.4.d` — Stale HTML runbook (`MINT_GO_LIVE_RUNBOOK.html`) needs replacement with `GO_LIVE_RUNBOOK.md`.
- `0.5.4.e` — Identified existing `mfxng…stock_intraday_c` writer before flipping the worker over.
- `0.5.4.f` — Worker default cadence 15s; drop to 5s on production only after verifying Vercel cost.

### Daily loop cadence (production)
- Quote: 15s
- Order poll: 60s
- TimeSeries: 300s
- Index intraday: 120s
- Curve: aligned with TimeSeries (300s)
- Heartbeat: 30s
- News: 21600s (6h)

### Single replica
- `workers.broker-ingest` Railway setting: `REPLICAS=1` (single replica).
- Multi-replica = 25008 collision.
- License pooling or Redis Stream handoff needed for zero-downtime redeploys.

---

## 15. Scripts (`workers/iress-ingest/scripts/`)

- `doctor.ts` — diagnostic check (env + DB + IRESS session).
- `entitlement-probe.ts` — probe `NewsHeadlineGet` + `PricingQuoteGet` + `OrderPadGetByAccount` for each symbol.
- `25008-recovery.ts` — interactive 25008 recovery helper.
- (others — per `ISSUES_LOG.md`)

---

## 16. Open gaps

- **`IRESS_ORDER_EXECUTION_ENABLED` flag missing** — production-order readiness gate is a sanity signal only.
- **Per-client attribution gap** — orders hard-forced to MKT with no client reference.
- **Broker fill pipeline mock-only** — no fills → `stock_holdings_c` bridge.
- **`avgPx` unit ambiguity** — pin the SOAP unit before trusting positions.
- **News vendor write gate** — `IRESS_NEWS_ALLOW_WRITES` default-off; news mostly seed.
- **Two-replica drain unsafe** — 25008 collision risk.
- **`WORKER_HTTP_TOKEN` rotation needed** — literal in `ISSUES_LOG.md`.
- **External Qentari pusher off-repo** (P1.4) — bring under ops control.
- **External IRESS programmer's guide reference** — `Documentation & Vision/iress-v4-docs/iress-programmers-guide.pdf` for definitive answers on parameter semantics.

---

*This doc is the worker deep-dive. Pair with Doc 4 (IRESS adapter) for the SOAP side, Doc 9 (API surface) for the BFF contracts, and Doc 11 (deployment) for the cutover playbook.*
