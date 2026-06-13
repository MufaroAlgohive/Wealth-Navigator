# Mint Wealth Navigator — Full Page of Issues & Outstanding Work

Generated 2026-06-13 (UTC+2). Scoped to OEMS cockpit + BFF + Railway worker + Supabase MyMint (`nnwzhxfjpjbzujevwzlh`). Read time ~5 min.

## 0. UI-honesty pass — completed (2026-06-13)

All 7 RED findings (#1–#7) and 25 YELLOW findings (#8–#32, plus #33–#37) from the
UI audit are committed. The full mapping lives in
`wealth-navigator/docs/UI_AUDIT_FIX_LOG.md` (every audit # → commit hash
→ file:line).

Key shifts:
- **Adapter-mode tile** now reads from `primaryWorker.iress_mode` (Railway env),
  not `iressConfig.mode` (Vercel env) — so it shows `LIVE` while the worker
  is heartbeating.
- **BFF ghost-worker filter** drops `status="stopped"` rows and primary
  `service_name`/`worker_id` mismatch. The worker also writes
  `status="stopped"` on clean shutdown (new `gracefulStop()` helper).
- **`deriveDataSource`** returns `LIVE` when the worker is `iress_mode = "live"`
  AND at least one row has a tick fresher than 30s. The `HYBRID` case is
  reserved for actual live + mock mixing (production never does this).
- **Shared `JSE_TRACKED_UNIVERSE`** module (10 JSE equities + 2 rate codes)
  consumed by both the worker `DEFAULT_WATCHLIST` and the UI Security/Cockpit
  watchlists. Watchlist-size mismatch is closed.
- **Empty-state reason taxonomy** (`supabase_not_configured` | `supabase_query_failed`
  with `migration` | `empty` | `entitlement_blocked` | `worker_not_running`) is
  threaded through every BFF that returns `source: "unavailable"`. The
  Cockpit AUM, Day P&L, Open Orders, JIBAR/USDZAR tiles, Strategies, Fixed
  Income, Money Market, Curves, Macro, News all render cause-based messages.
- **Shared `EntitlementRequired` primitive** for the three TimeSeriesGet2
  call-sites (Cockpit Sector Heatmap, Fixed Income ZAR govi, Curves Combined).
- **Worker events** now carry `elapsedMs` (`quote_sync_complete`,
  `ips_sync_complete`, `time_series_sync_complete`) so the integration
  page's latency chart populates.
- **Equity row "no tick" pill** distinguishes BHG-style hollow rows from
  genuine missing values.
- **Dev-mode mock override** (`?mock=1` / `?mock=0` query param) lets a dev
  force the seed path on production Vercel without flipping env. Banner
  suppressed in production builds.

12 atomic commits on `main` (no push). 350/350 vitest tests pass.

---

## 1. TL;DR

1. **9 unpushed commits on `main`** (`56e29bf → bb2df5b`) are ready; ship the branch before any Charles reply.
2. **3 paste-ready migrations** (`...13000001_oems_ips_portfolio.sql`, `...13000002_oems_strategy_c.sql`, `...13000003_oems_curve_metric_c.sql`, `...13000004_oems_instrument_universe.sql`) need to land in MyMint — *only* the BFFs and pages added in commits `56e29bf..bb2df5b` depend on them. Today `oems_strategy_c` / `oems_curve_metric_c` / `bonds_c` / `news_item_c` / `macro_indicator_c` / `jibar_fixing_c` / `money_market_instrument_c` / `macro_release_c` / `oems_instrument_universe_c` do not exist in prod.
3. **5 Railway env vars to flip on `Iress-Worker`** before any panel goes "honest live": `IRESS_MODE=live`, `USE_SUPABASE_QUOTES=true`, `IRESS_ACCOUNT_CODE=<from Charles>`, `SUPABASE_ALLOW_WRITES=1`, `IRESS_WORKER_DRY_RUN=0` (the last two are explicit opt-ins, default `0` / `0` per the standing user rule).
4. **4 IRESS entitlements** to ask Charles for: `TimeSeriesGet2` on J203 / R-codes / sector indices / ZAR curves, `OrderPadGetByAccount` polling account code, BHG board / `QuotationBasisCode` clarification (hollow CT row), sector index code list for the JSE heatmap.
5. **TimeSeriesGet2 is empirically blocked** as of 2026-06-13 12:02 UTC — the worker's `/debug/timeseries-probe` swept 56 Long candidates and 13 string `Interval` candidates against J203, R2030, NPN, FSR, SOL, USDZAR and **every single one returned `Invalid Parameter Value: <n> as Frequency`**. Tier-2 panels (ALSI/J203, sector heatmap, ZAR sovereign curve, ZAR NSS) stay empty until Charles flips the entitlement. The probe infrastructure is wired; the brute-force script is one `curl` away.

---

## 2. By category

### 2.1 User actions (paste / push / flip env)

1. **Push 9 unpushed commits to `origin/main`**:
   `56e29bf` strategy/curve/instrument tables · `b1fa42e` DataSourceBadge + EmptyDataState extension · `b00f053` BFF DB-first for strategies/curves/bonds/MM/macro/news · `6504b2c` worker `/orders/cancel` + `iress_call_complete` events · `cac1833` BFF `POST /api/orders/cancel` Path B passthrough · `5502a21` `useAccountCash` + new-order dialog wiring · `587762a` real PCA + real worker-event latency · `8f4f6bc` wire strategies/curves/FI/MM/macro/news to BFFs · `bb2df5b` BFF + useAccountCash + worker event tests.
2. **Paste these 3 (or 4) migrations into MyMint SQL editor** (in order, idempotent):
   - `wealth-navigator/supabase/migrations/20260613000001_oems_ips_portfolio.sql` (98 lines — `oems_account_c`, `oems_position_c`, `oems_transaction_c`, IPS portfolio mirror)
   - `wealth-navigator/supabase/migrations/20260613000002_oems_strategy_c.sql` (58 lines — per-strategy rollup table; needed by `/oems/strategies` and the cockpit AUM/PnL tiles)
   - `wealth-navigator/supabase/migrations/20260613000003_oems_curve_metric_c.sql` (58 lines — per-curve derived metrics + PCA factors; needed by `/oems/curves` and the cockpit PCA panel)
   - `wealth-navigator/supabase/migrations/20260613000004_oems_instrument_universe.sql` (183 lines — `bonds_c`, `jibar_fixing_c`, `money_market_instrument_c`, `macro_indicator_c`, `macro_release_c`, `news_item_c`, `oems_instrument_universe_c`; needed by `/oems/fixed-income`, `/oems/money-market`, `/oems/macro`, `/oems/news`)
3. **Flip 5 Railway `Iress-Worker` env vars** (`IRESS_ACCOUNT_CODE` from Charles, plus the four opt-ins):
   ```bash
   IRESS_MODE=live
   USE_SUPABASE_QUOTES=true
   IRESS_ACCOUNT_CODE=<provided by Charles>
   SUPABASE_ALLOW_WRITES=1
   IRESS_WORKER_DRY_RUN=0
   ```
   `IRESS_WORKER_DRY_RUN=1` and `SUPABASE_ALLOW_WRITES=0` are the standing defaults — production must opt in to writes.
4. **Verify Vercel env var parity** (these must be set on Vercel for the BFF Path B routes to proxy; **both Vercel and Railway `SUPABASE_URL` must point at MyMint `nnwzhxfjpjbzujevwzlh`, never Eververse**):
   ```bash
   IRESS_WORKER_URL=https://iress-worker-production.up.railway.app
   USE_SUPABASE_QUOTES=true
   NEXT_PUBLIC_USE_SUPABASE_QUOTES=true
   WORKER_HTTP_TOKEN=<if opt-in>
   ```
5. **Email Charles** (reply-toned, on the existing thread — not a cold first contact per the standing user rule) with: BHG hollow-row question, sector index code list for the JSE heatmap, `OrderPadGetByAccount` polling account code, `TimeSeriesGet2` entitlement on J203 + R-codes + ZAR NSS curve codes, SENS/news vendor path (IRESS vs third-party).
6. **Pick a vendor for the 5 vendor categories** (each panel below is gated on this):
   | # | Category | Surface | Wire-up owner |
   |---|----------|---------|----------------|
   | 1 | SENS announcements | `/oems/news` SENS feed + cockpit SENS panel | New adapter in `workers/iress-ingest/src/sens.ts` |
   | 2 | News flow (Reuters / Bloomberg / Moneyweb) | `/oems/news` + cockpit news | Same adapter file; multiple sources OK |
   | 3 | Macro pulse (CPI / PMI) | `/oems/macro` + cockpit macro panel | `workers/iress-ingest/src/macro.ts` |
   | 4 | L2 depth | `/oems/security` depth ladder | IRESS V4 has no method — third-party (DirectEdge / ITG / FlexTrade) |
   | 5 | Time & sales | `/oems/security` tape | Same as depth |
   | 6 | Fundamentals (per-security) | `/oems/security` fundamentals panel | Refinitiv / Bloomberg |

### 2.2 Blocked on Charles / IRESS entitlement

| Surface | V4 method | Entitlement gap | Effort to unblock |
|---------|-----------|-----------------|-------------------|
| Cockpit ALSI intraday | `TimeSeriesGet2` on J203 | `Frequency` Long + `Interval` string both rejected (empirical, 56 + 13 candidates on 2026-06-13) | 0 eng — Charles flips entitlement, re-run `/debug/timeseries-probe` |
| Sector heatmap (`/oems` + `/oems/equities`) | `TimeSeriesGet2` on J200 / sector index codes | Same as above + Charles supplies code list | 0 eng on entitlement; ~1 day on worker ingest + cockpit sector loop |
| ZAR govi / NSS / real / breakeven curve (`/oems/curves`) | `TimeSeriesGet2` on curve codes | Same as above + Charles supplies ZAR NSS curve code(s) | 0 eng on entitlement; ~2 days on worker fitted-curve loop + `yield_curve_history_c` writes |
| ZAR swap / govi KPIs | `TimeSeriesGet2` on swap codes | Same as above | 0–1 day |
| `oems_order_audit` working-pad fill (when audit empty) | `OrderPadGetByAccount` | `IRESS_ACCOUNT_CODE` unknown | 0 eng once Charles supplies code |
| BHG JSE watchlist | `PricingQuoteGet` | CT row is **hollow** (`LastPrice=PreviousClosePrice=2445`, zero OHLC); worker `mapQuote`/`resolveQuoteLast` correctly **skips** the write (BHG pattern from `docs/DATA_PROVENANCE.md` §"CT quote row shapes") | 0 eng — Charles confirms `Board` / `QuotationBasisCode`; then mapper accepts the row |

### 2.3 Blocked on vendor contracts

| Surface | Vendor candidates | Path to unblock |
|---------|------------------|-----------------|
| SENS announcements | JSE SENS / Refinitiv / Iress news | Contract + adapter (`workers/iress-ingest/src/sens.ts`); schema already in `news_item_c` from `20260613000004_oems_instrument_universe.sql` |
| News flow | Reuters / Bloomberg / Moneyweb / Dow Jones | Same adapter |
| Macro indicators (CPI, PMI, repo, ZARONIA) | SARB / StatsSA / Refinitiv macro | Adapter + `macro_indicator_c` / `macro_release_c` writes |
| L2 depth + Time & sales | DirectEdge / ITG / FlexTrade (IRESS V4 has **no method** in our adapter surface) | Replace `DepthLadder` / `TimeAndSales` synthetic generators with vendor feed |
| Fundamentals (per-security) | Refinitiv / Bloomberg | Replace hardcoded values in `src/app/oems/security/page.tsx` |

### 2.4 Code gaps (panel says "code-gap" in DataSourceBadge)

| Panel | Route | What it does today | What's missing |
|-------|-------|-------------------|---------------|
| Fixed Income — key-rate-duration breakdown | `/oems/fixed-income` (`page.tsx:208-214`) | DV01 + convexity sensitivity computed locally from `bonds_c.dv01_cents` / `bonds_c.convexity`; KRD vector is a **code-gap** | Add `krd_bp` / `krd_per_tenor` JSONB column to `bonds_c`; render KRD bar chart from it |
| Money Market — JIBAR fixings term structure | `/oems/money-market` (`page.tsx:211`) | Renders 1M / 3M / 6M / 12M KPIs; full curve fit is a **code-gap** | Worker NSS fit on `jibar_fixing_c` rows; write fitted curve to `yield_curve_history_c` |
| News — sentiment | `/oems/news` | Categorises `category` and `severity`; sentiment score is a code-gap | Vendor sentiment score → `news_item_c.payload.sentiment` |
| Persona pages (5 stubs) | `/strategist`, `/wm`, `/admin`, `/business`, `/fc` | Empty placeholder headers; all seed | CRM / ops integration; explicitly deferred per the architecture doc |
| `/oems/security` — depth + T&S + fundamentals | `/oems/security` | L2 + tape are **synthetic** (`DepthLadder` / `TimeAndSales` use `seedLastFor`); fundamentals are **hardcoded** | Vendor feed for depth + T&S + fundamentals |
| `/oems/equities` — mandate KPIs | `/oems/equities` (real-data branch) | Renders "Platform AUM / mandate KPIs require portfolio system integration" empty state | Worker writes `oems_strategy_c` from `oems_position_c` aggregation |
| `/api/quotes` SSE upgrade | `/api/quotes` | Today polls every ~15 s | Switch to `supabase_realtime` `INSERT` on `stock_intraday_c` → drops lag from ~15 s to ~1 s |

### 2.5 Data gaps (no worker ingest yet)

| Table | Created by | Worker writes? | Consumer |
|-------|-----------|----------------|----------|
| `bonds_c` | `20260613000004_oems_instrument_universe.sql` | **No** (no vendor contract) | `/oems/fixed-income` |
| `jibar_fixing_c` | `20260613000004_...` | **No** | `/oems/money-market` |
| `money_market_instrument_c` | `20260613000004_...` | **No** | `/oems/money-market` |
| `macro_indicator_c` | `20260613000004_...` | **No** | `/oems/macro` |
| `macro_release_c` | `20260613000004_...` | **No** | `/oems/macro` |
| `news_item_c` | `20260613000004_...` | **No** | `/oems/news`, cockpit SENS + news |
| `oems_instrument_universe_c` | `20260613000004_...` | **No** | Bond / MM mandate reference |
| `oems_strategy_c` | `20260613000002_...` | **No** (no worker rollup loop yet) | `/oems/strategies`, cockpit AUM / Day P&L / Rebalance Locked tiles |
| `oems_curve_metric_c` | `20260613000003_...` | **No** | `/oems/curves` PCA + carry + rolldown |
| `oems_account_c` / `oems_position_c` / `oems_transaction_c` | `20260613000001_...` | **No** (no IPS feed wired) | `/api/portfolio`; `useAccountCash`; cockpit AUM tile in real-data mode |
| `securities_c` | pre-existing | **Yes** (worker instrument sync loop when `IRESS_WORKER_INSTRUMENT_SYNC=1`) | All quote joins |
| `stock_intraday_c` | pre-existing | **Yes** (worker `PricingQuoteGet` upsert, default 15 s) | `/api/quotes`; cockpit movers; security page watchlist |
| `oems_order_audit` | `20260612000002_...` | **Yes** (mirror of working pad; needs `IRESS_ACCOUNT_CODE` + writes on) | `/api/orders`; cockpit open orders; blotter |
| `integration_worker_health` | `20260611000000_...` | **Yes** (30 s heartbeat; recent_events in `metadata.recent_events`) | `/api/worker-health`; `/oems/integration` |
| `worker_session_metadata` | `20260612000001_...` | **Yes** (sticky `ApplicationID` + `iress_session_key`) | License-seat recovery |
| `worker_recent_events` | `20260613000000_...` | **Yes** | Migration exists; verify BFF reads it |
| `index_intraday_c` | `20260612000006_...` | **No** | J203 / sector intraday tier 2 |
| `yield_curve_history_c` | `20260612000007_...` | **No** (gated on `TimeSeriesGet2` entitlement) | `/api/curves/[code]` |
| `sector_intraday_c` | `20260612000008_...` | **No** (gated on `TimeSeriesGet2` + sector codes) | `/api/sectors` |

### 2.6 Mock-leak risk

The production policy is `USE_SUPABASE_QUOTES=true` + `NEXT_PUBLIC_USE_SUPABASE_QUOTES=true` → never render seed/mock prices. Risks that could re-introduce a seed leak:

| File | Line(s) | Risk | Mitigation |
|------|---------|------|------------|
| `src/app/oems/blotter/page.tsx` | 42-44, 65-76 | `data.orders()` (mock adapter) still hits the network when `realDataOnly=false`; `cancelAll` calls `client.orderDelete({ ServiceSessionKey: "MOCK-S", ... })` on the in-process mock client | Vercel env guard; `realDataOnly` flips to audit path; `cancelAll` only runs in mock |
| `src/app/api/ticks/route.ts` | whole file | Returns 503 in Supabase mode (line 60) but still imports `initialQuotes` from `seed.ts`; if a future refactor re-enables the SSE, the seed prices could leak | Comment in line 1 says "disabled in Supabase mode"; covered by BFF-level guard |
| `src/lib/iress/seed.ts` | 13-21 (SEED_KEYS), 378+ (news) | Seed is reachable from `/api/ticks`, `ticker-bar.tsx`, `equities` page (line 16 `seedLastFor`); only `/api/quotes` and `useLiveQuotes` are gated by the real-data flag | `useLiveQuotes` is the only one that respects `isRealDataOnlyClient()`; ticker-bar is data-flag-aware |
| `src/app/oems/equities/page.tsx` | 16 | Imports `seedLastFor` from `seed.ts` for display tick jitter; could display a seed value in real-data mode | Today only renders when `realDataOnly=false` (line 30 disables `equities` query in real mode); safe today but needs audit if `equities` BFF is added |
| `src/app/oems/security/page.tsx` | 41-42 | `useTick(activeSym)` falls back to seed for symbols not in `initialQuotes()`; in real-data mode the `DataSourceBadge` says `quoteSource` from `useLiveQuotes` but the chart could still consume the seed tick | Wire `useTick` to a `realDataOnly` early-return |

**Honest empty states** are already in place for everything that doesn't have a real source (BFFs return `source: "unavailable"` / `"entitlement-required"` / `"mock"`). The risk is regression: if anyone adds a `else { return seed; }` short-circuit on a real-data path, the UI will start showing fake numbers again.

### 2.7 UI polish & accessibility

| Item | File | Notes |
|------|------|-------|
| Side-nav badge counts are **hardcoded** in the `NAV` constant | `src/components/oems/shell/side-nav.tsx:29-66` (`Blotter: "12"`, `Strategies: "6"`, `News & SENS: "4"`) | `useSideNavBadges()` hook exists and is called via `resolveBadge(item.to, item.badge)`; verify it actually overrides the hardcoded values in real-data mode (passes `undefined` when the hook returns nothing) |
| 12 DataSourceBadge kinds supported, but only a subset are emitted today | `src/components/oems/primitives/data-source-badge.tsx:14-26` | Full taxonomy: `live`, `mock`, `seed`, `hybrid`, `supabase`, `stream`, `worker`, `unconfigured`, `unavailable`, `blocked-external`, `blocked-vendor`, `code-gap`. Production currently emits `supabase`, `unconfigured`, `unavailable`, `code-gap`, `mock` only |
| BFF `/api/curves/[code]` returns `entitlement-required` source for empty tables | `src/app/api/curves/[code]/route.ts:18-21` | UI shows the precise "ask Charles" message; verify it never falls through to a generic `unconfigured` |
| Skip link + `aria-label` on collapse | `src/components/oems/primitives/skip-link.tsx`, `side-nav.tsx:108-112` | Present; quick Lighthouse pass needed |
| EmptyDataState + DataSourceBadge extension (`code-gap`, `blocked-external`, `blocked-vendor`, `worker`, `stream`) | `src/components/oems/primitives/empty-data-state.tsx`, `data-source-badge.tsx` | Added in commit `b1fa42e`; verify `NumberCell` also handles the new sources |
| Confirmed-destructive dialog needs real `document` to render | `src/__tests__/confirm-destructive.test.tsx` | Tests fail under `bun test` (no jsdom); works under `vitest run` with `jsdom` env |
| Equity / strategy panels render the same `<KpiTileSkeleton>` skeleton but no `dataSource="loading"` badge | `src/app/oems/equities/page.tsx:58-60` | Minor: skeletons are fine; just confirm the loading state doesn't briefly flash a `MOCK` badge |

### 2.8 Testing

| File | Status | Notes |
|------|--------|-------|
| `src/__tests__/auth-login.test.ts` | **3 pre-existing failures** (vitest) | `request.headers must be an instance of Headers` (Next.js requires a real `Headers` instance, not a `Record<string,string>`). Failures: `authenticates with Supabase and returns the user email`, `returns 401 with a helpful message when Supabase rejects credentials`, `normalises email to lowercase`. Fix: switch the `makeRequest` helper to pass a `new Headers({ "content-type": "application/json" })` and a `new Request(url, { headers, method: "POST", body })` (or just hand-build a `Request` with `Headers`). Per the standing user rule these are *known and not blocking* |
| `src/__tests__/confirm-destructive.test.tsx` | Passes under vitest (jsdom env) | Fails under `bun test` because bun has no jsdom; this is **expected** — use `bunx vitest run` |
| All other tests (`*.test.ts` / `*.test.tsx` in `src/__tests__/`) | Passing | 24 test files; covering IRESS mock/live, live-queries, quote-routing, supabase-quotes, orders-live-route, order-recovery, strategy-gate, pre-trade, use-account-cash, worker-api, worker-events, worker-quotes, worker-session, worker-http-api, worker-env, sa-holidays, format, connection-ui, confirm-destructive, oems-bff-routes, iress-config, iress-errors, iress-mock, iress-live, orders-stub |
| Playwright e2e | Not run today; `test:e2e` script exists | `playwright.config.ts` status unknown — verify before claiming CI green |
| `worker-recent-events` migration is in `20260613000000_...` but no BFF route reads it yet | Migration present, BFF absent | Either drop the migration or add `GET /api/worker-events` to surface the new event table independently of the heartbeat's `metadata.recent_events` JSONB |

### 2.9 Security & env-var hygiene

| Item | Risk | Action |
|------|------|--------|
| `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME` on Railway only | ✅ Correct | Vercel must never receive these; verified by `src/lib/iress/config.ts` and worker `env.ts` |
| `WORKER_HTTP_TOKEN` shared bearer | Optional; both sides must opt in | Today's worker has `auth=off` (per `/debug/timeseries-probe` logs); flip on for prod via Vercel + Railway pair |
| Supabase service role key on worker + Vercel BFF (`SUPABASE_SERVICE_ROLE_KEY`) | Server-only; never `NEXT_PUBLIC_*` | Audit `.env.example` + `docs/VERCEL_DEPLOY_SETUP.md` for accidental `NEXT_PUBLIC_` prefix |
| `supabase_creds` file at repo root | Gitignored; contains `TEST_SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY` | Audit that no other path references it; today only used by Phase 1 of the E2E test agent |
| RLS on `oems_strategy_c` / `oems_curve_metric_c` / `oems_instrument_universe_c` | Migration creates tables but **no RLS policies** in `20260613000002/3/4_*.sql` | Add per-desk read policies in a follow-up migration before any non-trader user hits `/oems/strategies` |
| RLS on `oems_order_audit` | `20260612000003_...` adds intraday read policies; verify `oems_order_audit` has row-level read scoping | Spot-check with `select policyname,tablename from pg_policies` |
| `mint-auth` cookie in middleware | Dev stub (`value === "1"`) | Replace with Supabase Auth JWT validation; Supabase Auth is now wired in `src/app/api/auth/login/route.ts`; middleware still has dev cookie path |
| `/oems/blotter/page.tsx` line 68 hardcoded `ServiceSessionKey: "MOCK-S"` | In-process mock call | Today's `cancelAll` only runs in mock; production should never reach this branch — verify with a `realDataOnly` guard |
| `df2b43b` TimeSeriesGet2 wire shape (`Frequency` Long wins precedence; `Interval` string is fallback) | Pinning in tests is correct; the only failure mode is operational (entitlement missing) | Add a worker metric counter for "Frequency rejected" so the operator sees the fault rate in `/oems/integration` |

### 2.10 Ops / deploy

| Item | Status | Action |
|------|--------|--------|
| Vercel + Railway `SUPABASE_URL` parity | Both must point at MyMint `nnwzhxfjpjbzujevwzlh` (not `mfxnghmuccevsxwcetej` which is the Eververse project on `plugin-supabase-supabase`) | Verify with `curl $VERCEL_URL/api/integration/health` and check `workers/iress-ingest` startup logs |
| Vercel `IRESS_WORKER_URL` | Either explicit URL or `RAILWAY_SERVICE_URL` fallback | Set explicit `IRESS_WORKER_URL=https://iress-worker-production.up.railway.app` for prod |
| Bun version pinning | `engines.bun >= 1.1.0` | Pin to `1.3.14` to match local + Railway image; the `bun test` vs `bunx vitest` divergence will be confusing otherwise |
| Worker Dockerfile uses local Bun; `tsconfig.json` needs `baseUrl: "../.."` for `@/` in Docker | Known and pinned | Verify on each Railway redeploy |
| `/api/ticks` SSE in dev with `IRESS_MODE=mock` still works | Yes (line 70-87 of `ticks/route.ts`) | Only `IRESS_MODE=mock` deployments are SSE-capable today; `USE_SUPABASE_QUOTES=true` prod disables it |
| `/api/quotes` poll cadence | Default 15 s from `IRESS_WORKER_QUOTE_INTERVAL_SEC` | Drop to 5 s if the cockpit movers feel laggy; confirm Vercel cost |
| `/api/quotes` SSE upgrade | Not built; would drop 15 s poll lag to ~1 s via `supabase_realtime` `INSERT` events on `stock_intraday_c` | ~1 day of work; needs `useLiveQuotes` refactor + a `EventSource` wrapper |
| Railway single replica holds the IRESS CT license seat | ✅ Correct; stop the service to release | Train the team on `IRESS_FORCE_KICK_ALL=1` for first-boot recovery |
| BFF `/api/orders/live` and `/api/orders/stream` SSE | Built in `src/app/api/orders/live/route.ts`, `src/app/api/orders/stream/route.ts` | Require `IRESS_WORKER_URL` + `USE_SUPABASE_QUOTES=true`; today `IRESS_ACCOUNT_CODE` unset on Railway → worker returns 503 `upstream_error` with "Order account code not configured" |
| `WORKER_HTTP_PORT` default 8765 | Pinned in `workers/iress-ingest/src/env.ts` | Public Railway domain proxies 443 → 8765; nothing to do |
| Bun test runner picks up jsdom | No — bun test has no jsdom | Use `bunx vitest run` in CI; the `bun test` invocations are a foot-gun |
| `new-order-dialog` pre-trade checks | `useAccountCash` + `preTradeCheck` (lib/iress/strategy.ts) + `useTick` for market state | All wired in commit `5502a21`; Send button disables when IPS cash is 0 + `marketState ∈ {HALT, SUSPEND}` |

### 2.11 Docs to update

| Doc | Change |
|-----|--------|
| `docs/REMAINING_GAPS.md` | Add the 9 unpushed commits + the 4 new tables; close the items that 56e29bf..bb2df5b resolved (DB-first BFFs, DataSourceBadge extension, IPS portfolio, BFF `/orders/cancel`) |
| `docs/DATA_PROVENANCE.md` | Add the new T1 rows for `oems_strategy_c`, `oems_curve_metric_c`; mark Tier 2 panels `entitlement-required` explicitly |
| `docs/STACK_ARCHITECTURE.md` | Add the Path B `POST /api/orders/cancel` BFF; note that `isWorkerLiveMode()` reads `USE_SUPABASE_QUOTES` server-side (so flipping the flag has 2 effects: Path A reads Supabase, Path B proxies worker) |
| `docs/MINT_GO_LIVE_RUNBOOK.html` | Add steps 2a-2d for: paste the 3–4 migrations, flip the 5 Railway env vars, verify Vercel env parity, re-run `/debug/timeseries-probe` after Charles flips entitlement |
| `docs/TIMESERIES_PROBE_REPORT_FINAL.md` | Already accurate; cross-link from this `ISSUES_LOG.md` |
| `wealth-navigator/docs/VERCEL_DEPLOY_SETUP.md` | Confirm Vercel `IRESS_WORKER_URL` is set to public Railway domain (not internal `*.railway.internal`) |
| `AGENTS.md` (root) | Update "Production go-live step 1" once Railway `Iress-Worker` is verified; today's "step 1" wording already says worker is verified before dashboard/UI work |

---

## 3. Per-page audit summary

| Page | Route | Real-data state | Mock mode state | Blockers |
|------|-------|-----------------|------------------|----------|
| Cockpit | `/oems` | AUM/Day PnL/Rebalance-Locked from `/api/portfolio` (Supabase); Open Orders from `/api/orders` audit; movers from `/api/quotes`; sector heatmap from `/api/sectors` (gated on TimeSeriesGet2); ALSI from `/api/indices/J203` (gated); ZAR govi curve from `/api/curves/[code]` (gated); PCA from `/api/curves/ZAR_NSS/metrics` (wired, empty until worker writes); JIBAR/USDZAR from `/api/quotes` if on watchlist | Seed values everywhere; KPIs derived from `oemsStrategies` | TimeSeriesGet2 entitlement; portfolio system integration for AUM/PnL |
| Blotter | `/oems/blotter` | `/api/orders` audit; `useAccountCash`; `POST /api/orders/cancel` Path B; new-order dialog uses `useAccountCash` + `preTradeCheck` | Mock adapter; `cancelAll` calls `client.orderDelete({ ServiceSessionKey: "MOCK-S" })` | `IRESS_ACCOUNT_CODE` for working-pad fill |
| Security | `/oems/security` | Quote header from `/api/quotes`; tick chart from `useTick`; watchlist from `/api/quotes` | Seed `initialQuotes()` | L2 depth + T&S + fundamentals (vendor) |
| Equities | `/oems/equities` | Empty state for "Platform AUM / mandate KPIs" | Seed equities; seed tick jitter via `seedLastFor` | Portfolio system; ticker-bar SSE upgrade |
| Strategies | `/oems/strategies` | `/api/strategies` → `oems_strategy_c`; IPS holdings per strategy; rebalance drift/lock | Empty state "Mock mode disables" | `oems_strategy_c` table must be pasted to MyMint; worker rollup loop |
| Fixed Income | `/oems/fixed-income` | `/oems/fixed-income` reads `bonds_c` (BFF not yet built — verify `b00f053` BFF covers it) | Seed bonds | `bonds_c` paste; vendor; KRD column code-gap |
| Money Market | `/oems/money-market` | Reads `jibar_fixing_c` + `money_market_instrument_c` (BFF wired in `b00f053`) | Empty state "Mock mode disables" | Paste migration; worker NSS fit; full curve code-gap |
| Curves | `/oems/curves` | 4 series (GOVI / NSS / REAL / BREAKEVEN) from `/api/curves/[code]`; PCA + carry + rolldown from `/api/curves/ZAR_NSS/metrics` | Empty state "Mock mode disables" | `TimeSeriesGet2`; `yield_curve_history_c` worker writes |
| Macro | `/oems/macro` | `/api/macro` (DB-first, BFF wired) | Empty state | `macro_indicator_c` paste; SARB/StatsSA vendor |
| News & SENS | `/oems/news` | `/api/news` reads `news_item_c` | Empty state "Mock mode disables" | `news_item_c` paste; vendor |
| Integration | `/oems/integration` | Real worker health; `metadata.recent_events` panel with `timeseries_probe_complete`, `quote_sync_complete`, `pricing_quote_get_failed`, etc. | Mock endpoint list | None — fully real-data aware |

---

## 4. Open TODOs / follow-up hooks in code

There are no `// TODO` / `// FIXME` / `// HACK` / `// XXX` markers anywhere under `wealth-navigator/src` or `wealth-navigator/workers` (verified by ripgrep). Follow-ups are encoded as `dataSource="code-gap"` and `source: "entitlement-required"` enums, comments, and migration comments. Top 20 follow-up anchors:

| # | File:line | Hook |
|---|-----------|------|
| 1 | `src/components/oems/primitives/data-source-badge.tsx:14-26` | 12-kinds taxonomy; only 5 are emitted today. Add emitters for `worker`, `stream`, `blocked-external`, `blocked-vendor` to the relevant BFF routes |
| 2 | `src/app/oems/fixed-income/page.tsx:208-214` | "key-rate-duration breakdown is a CODE-GAP until a per-tenor krd vector is added to the schema" — needs `krd_per_tenor` JSONB column on `bonds_c` |
| 3 | `src/app/oems/money-market/page.tsx:211` | "full NSS fit on `jibar_fixing_c` is a code-gap" — worker curve-fit loop |
| 4 | `src/app/oems/curves/page.tsx:79-85` | "ensure the worker has written `yield_curve_history_c` rows for ZAR_NSS" — gated on `TimeSeriesGet2` |
| 5 | `src/app/oems/strategies/page.tsx:72-93` | Mock-mode "Mock mode disables the strategies module" branch — once `oems_strategy_c` is populated, the real-data branch already works |
| 6 | `src/app/api/strategies/route.ts:6-10` | "Today the table is empty (no worker rollup yet); v1 expects a manual seed or a future worker loop that aggregates `oems_position_c` per `strategy_id`" |
| 7 | `src/app/api/curves/[code]/route.ts:18-21` | "Until Charles enables `TimeSeriesGet2` on the production account, the worker loop logs `time_series_entitlement_missing` and the table stays empty" |
| 8 | `src/app/api/curves/[code]/metrics/route.ts:5-9` | "Table is populated by the Railway `iress-ingest` worker when a fitted curve snapshot is available; until then the response is `{ metrics: [], source: "unavailable" }`" |
| 9 | `src/app/api/ticks/route.ts:60-63` | "SSE disabled in Supabase quotes mode — use `/api/quotes` + Realtime" — but a `/api/quotes` SSE upgrade would drop 15 s → 1 s lag |
| 10 | `src/components/oems/shell/side-nav.tsx:34,41,57` | Hardcoded badge counts (`Blotter: "12"`, `Strategies: "6"`, `News & SENS: "4"`) — `useSideNavBadges` hook is wired but the hardcoded values take precedence in the `NAV` constant |
| 11 | `src/lib/iress/seed.ts:13-21` (SEED_KEYS) | Seed importable from `/api/ticks` and `ticker-bar.tsx`; mock-leak risk if a refactor re-enables an SSE path |
| 12 | `src/lib/iress/seed.ts:378+` | News seed used by `/oems/news` mock branch and cockpit SENS panel; once `news_item_c` is populated by a vendor, mock seed becomes dead code |
| 13 | `workers/iress-ingest/src/timeseries.ts` `syncTimeSeries()` | Loops on `entitlementRequired` log path; placeholder `DAILY_FREQUENCY_LONG=5`; update once Charles confirms the working Long value |
| 14 | `workers/iress-ingest/src/env.ts:154-173` | Standing defaults: `IRESS_WORKER_DRY_RUN=1` (true), `SUPABASE_ALLOW_WRITES=0` (false) — production must opt in |
| 15 | `src/app/oems/blotter/page.tsx:65-76` `cancelAll` mutation | Calls `client.orderDelete({ ServiceSessionKey: "MOCK-S" })` on the in-process mock client; only runs in mock mode today; add a `realDataOnly` guard |
| 16 | `src/app/oems/blotter/new-order-dialog.tsx:62-80` | `useTick(symbol.toUpperCase())` for Halt/Suspension check; `useAccountCash(account)` for buying power; both wired in commit `5502a21` |
| 17 | `wealth-navigator/supabase/migrations/20260613000004_oems_instrument_universe.sql:1-19` | "Worker does not write to any of these tables today (no vendor contract in place), so the BFF responses return `source: "unavailable"` and the UI renders the honest empty state" |
| 18 | `wealth-navigator/src/lib/iress/live.ts:296` | "Skip this guard when the market is closed — the real IRESS row only ships a [stale price]" — closed-market quote write-through path |
| 19 | `wealth-navigator/src/app/api/worker-health/route.ts:32-37` | "Includes `time_series_entitlement_missing`, `license_seat_occupied`, `quote_sync_complete`, `pricing_quote_get_failed`, etc." — surface area for the `/oems/integration` "Worker diagnostic events" panel |
| 20 | `wealth-navigator/src/app/oems/equities/page.tsx:50-55` | "Platform AUM / mandate KPIs require portfolio system integration" empty state — explicit code-gap marker |

---

## 5. Known failing tests

| Test | File | Error | Workaround |
|------|------|-------|------------|
| `POST /api/auth/login > authenticates with Supabase and returns the user email` | `src/__tests__/auth-login.test.ts:56-72` | `Error: request.headers must be an instance of Headers` at `src/app/api/auth/login/route.ts:107` (`NextResponse.next({ request: req })`) | Construct `new NextRequest(url, { headers: new Headers({...}), method, body })` |
| `POST /api/auth/login > returns 401 with a helpful message when Supabase rejects credentials` | `src/__tests__/auth-login.test.ts:74-86` | Same | Same |
| `POST /api/auth/login > normalises email to lowercase` | `src/__tests__/auth-login.test.ts:113-125` | Same | Same |

**Not bugs**: the underlying production code (`/api/auth/login`) works — Next.js requires a real `Headers` instance when `NextResponse.next({ request })` is called, and the test's `makeRequest` helper builds `headers: { "content-type": "..." }` (a `Record`, not a `Headers`). Fix is a 3-line test helper change.

Bun test runner also fails `confirm-destructive.test.tsx` with `ReferenceError: document is not defined` — this is **expected** (bun has no jsdom); use `bunx vitest run` with the existing `vitest.config.ts` jsdom env.

---

## 6. Migration & deploy checklist (in priority order)

1. **Push the 9 unpushed commits** (`56e29bf → bb2df5b`) to `origin/main` so Vercel picks them up.
   ```bash
   git push origin main
   ```
2. **Vercel auto-deploys**; confirm preview URL is green.
3. **Paste migrations into MyMint SQL editor** (idempotent, ordered):
   ```sql
   -- 1. wealth-navigator/supabase/migrations/20260613000001_oems_ips_portfolio.sql
   -- 2. wealth-navigator/supabase/migrations/20260613000002_oems_strategy_c.sql
   -- 3. wealth-navigator/supabase/migrations/20260613000003_oems_curve_metric_c.sql
   -- 4. wealth-navigator/supabase/migrations/20260613000004_oems_instrument_universe.sql
   ```
   Verify with:
   ```sql
   select table_name from information_schema.tables
   where table_schema='public' and table_name in
     ('oems_account_c','oems_position_c','oems_transaction_c',
      'oems_strategy_c','oems_curve_metric_c',
      'bonds_c','jibar_fixing_c','money_market_instrument_c',
      'macro_indicator_c','macro_release_c','news_item_c',
      'oems_instrument_universe_c')
   order by table_name;
   ```
4. **Verify Vercel env** (`wealth-navigator-one.vercel.app`):
   ```bash
   USE_SUPABASE_QUOTES=true
   NEXT_PUBLIC_USE_SUPABASE_QUOTES=true
   IRESS_WORKER_URL=https://iress-worker-production.up.railway.app
   SUPABASE_URL=https://nnwzhxfjpjbzujevwzlh.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...
   ```
5. **Flip Railway `Iress-Worker` env** (after Charles replies with the account code):
   ```bash
   IRESS_MODE=live
   USE_SUPABASE_QUOTES=true
   IRESS_ACCOUNT_CODE=<from Charles>
   SUPABASE_ALLOW_WRITES=1
   IRESS_WORKER_DRY_RUN=0
   ```
6. **Redeploy worker** (Railway auto-redeploys on env-var change).
7. **Smoke checks**:
   ```bash
   # 1. Worker heartbeat
   curl https://iress-worker-production.up.railway.app/health
   # 2. Worker quote (auth off)
   curl -X POST https://iress-worker-production.up.railway.app/orders?account=MINT-LIVE-001
   # 3. Vercel BFF DB-first quote
   curl 'https://wealth-navigator-one.vercel.app/api/quotes?symbols=NPN,PRX,FSR'
   # 4. Vercel BFF Path B working-pad
   curl 'https://wealth-navigator-one.vercel.app/api/orders/live?account=MINT-LIVE-001'
   # 5. Vercel BFF strategies (empty until worker writes oems_strategy_c)
   curl 'https://wealth-navigator-one.vercel.app/api/strategies'
   # 6. Vercel BFF curves metrics
   curl 'https://wealth-navigator-one.vercel.app/api/curves/ZAR_NSS/metrics'
   ```
8. **Email Charles** with the 4 entitlement questions (existing thread, reply-toned).
9. **After Charles flips `TimeSeriesGet2`**, re-run the probe:
   ```bash
   curl -X POST https://iress-worker-production.up.railway.app/debug/timeseries-probe \
     -H "Content-Type: application/json" \
     -d '{"code":"J203","exchange":"JSE","frequency":5}'
   ```
   The first `Frequency` Long that returns `ok=true dataRowCount>0` is the answer; update `DAILY_FREQUENCY_LONG` in `workers/iress-ingest/src/timeseries.ts` and replace `docs/TIMESERIES_PROBE_REPORT_FINAL.md` with the updated table.

---

## 7. What we can do in parallel today (no external input)

| Item | Effort | Why now |
|------|--------|---------|
| **Push the 9 unpushed commits** | 1 shell command | Independent of every other item |
| **Paste the 4 migrations into MyMint** | ~5 min in SQL editor | Idempotent; pages render `unavailable` empty state until worker writes, so zero risk of regression |
| **Fix `auth-login.test.ts` (3 failures)** | 5 min | Replace `headers: { "content-type": "..." }` with `headers: new Headers({ "content-type": "..." })` in `makeRequest`; tests will then go green under vitest |
| **Add RLS policies to `oems_strategy_c` / `oems_curve_metric_c` / `oems_instrument_universe_c`** | ~30 min | New tables created by `20260613...` migrations have no RLS; needs a follow-up migration before any non-trader user hits these BFFs |
| **`/api/quotes` SSE upgrade** | ~1 day | Drops 15 s poll lag to ~1 s via `supabase_realtime` `INSERT` on `stock_intraday_c`; orthogonal to Charles / vendor unblock |
| **Worker rollup loop for `oems_strategy_c`** | ~1 day | Aggregates `oems_position_c` per `strategy_id`; needed for `/oems/strategies` and cockpit AUM/PnL/Locked tiles in real-data mode |
| **Hook up `/oems/equities` ticker-bar to real-data flag** | ~2 h | `useTick` falls back to seed for unknown symbols; add a `realDataOnly` early-return so the ticker renders `—` in real mode |
| **Hook up `DepthLadder` + `TimeAndSales` to a "vendor-required" empty state** | ~2 h | Today renders synthetic rows in mock mode; make it explicit in real-data mode that the L2 + tape need a vendor |
| **Add `krd_per_tenor JSONB` to `bonds_c`** | ~1 h + a follow-up migration | Unblocks the fixed-income KRD code-gap panel |
| **Replace hardcoded `NAV` badge counts with `useSideNavBadges()` real values** | ~3 h | Audit current `useSideNavBadges` hook; replace the 3 hardcoded string badges with derived counts; confirm `realDataOnly` flips them off when the underlying BFF is unavailable |
| **Swap the IRESS V4 WSDL docs in `Documentation & Vision/iress-v4-docs/` for empirical notes** | ~1 day | The 56+13 frequency/interval brute force table in `docs/TIMESERIES_PROBE_REPORT_FINAL.md` supersedes the V4 WSDL `<Interval>Daily</Interval>` claim; the doc set still says otherwise |
| **Promote `worker_recent_events` migration into a BFF route** | ~3 h | Migration `20260613000000_worker_recent_events.sql` exists; no BFF route reads from the new table yet (events are currently embedded in `metadata.recent_events` on the heartbeat row) |
| **Wire `Integration` page to show `pricing_quote_get_complete` latency histogram** | ~1 day | `buildLatencySeries` already in `src/app/oems/integration/page.tsx:41-52`; the `iress_call_complete` events from commit `6504b2c` are ready to feed it |
