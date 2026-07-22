# Remaining Data Gaps — Real Data Mandate

Last updated: 2026-06-26. Production policy: `USE_SUPABASE_QUOTES=true` + `NEXT_PUBLIC_USE_SUPABASE_QUOTES=true` → **no seed/mock prices in UI**. Empty states show `Data feed not configured`. The news panel reads `/api/news` (RSS + the `News_articles` wire), showing SEED only in mock mode; `/api/iress/news` is an unwired Path B probe over the worker `NewsVendorGet`, not the panel's live source.

## Wired in this session

| Surface | Source | Route/API |
|---------|--------|-----------|
| Watchlist / movers prices | `stock_intraday_c` + Realtime | `/api/quotes`, `useLiveQuotes` |
| Tick SSE / random walk | Disabled in prod | `/api/ticks` → 503 |
| Missing quote (e.g. BHG hollow CT row) | `—` not seed 528 | `NumberCell`, `live-queries` `unavailable` |
| Open orders (cockpit + blotter) | `oems_order_audit` | `/api/orders` |
| Integration worker status | `integration_worker_health` | `/api/worker-health` |
| Instrument metadata | `securities_c` | joined in `/api/quotes` |
| Blotter mock create/cancel | Hidden in prod | `blotter/page.tsx` |
| Blotter new-order preflight + force-correction | `submitOrder()` core + `/uat/preflight` worker | `submitOrder`, `uat-preflight-route.test.ts`, `force-correction-dialog.test.tsx` (2026-07-20) |
| UAT ad-hoc preflight gate | `/api/admin/orderbook/uat-order` calls worker preflight before insert | `uat-preflight-route.test.ts` (2026-07-20) |
| Bulk `runLimitGuard` partial-fill reservation | `qty - filled` instead of `quantity` | `runLimitGuard.test.ts` (2026-07-20) |
| Per-client open-order reservation (IRESS_PER_CLIENT_GUARD) | wired in `pretrade-guard.ts` | dormant behind flag (2026-07-20) |
| Typed `broker_account_code` column | `oems_order_audit.broker_account_code` + migration | `supabase/migrations/20260720000001_oems_order_audit_broker_account.sql` (2026-07-20) |
| Security lookup quotes | `/api/quotes` | `security/page.tsx` |
| Equities grid quotes | `/api/quotes` | `equities/page.tsx` |
| Ticker bar (equities) | Supabase ticks only | `ticker-bar.tsx` |
| Strategies / FI / MM / curves / macro / news | EmptyDataState | respective `/oems/*` pages |
| Persona pages | EmptyDataState | `/strategist`, `/wm`, `/admin`, `/business`, `/fc` |

## Requires IRESS entitlement (Charles / CT)

| Surface | IRESS V4 method | Notes |
|---------|-----------------|-------|
| Sector heatmap | `PricingQuoteGet` on J200 / sector index codes | Need symbol list + entitlement |
| ALSI intraday | `TimeSeriesGet2` on J203 | Index time series |
| ZAR govi / swap curves | `TimeSeriesGet2` | Curve codes TBD with IRESS |
| JIBAR / USDZAR KPIs | `PricingQuoteGet` | Add symbols to worker watchlist |
| FX crosses (EURZAR, etc.) | `PricingQuoteGet` | Worker watchlist expansion |
| Live orders (if audit empty) | `OrderPadGetByAccount` | Worker needs `IRESS_ACCOUNT_CODE`, writes enabled |
| Depth L2 | TBD | No V4 method wired |
| Time & sales | TBD | No V4 method wired |

## Requires external vendor / portfolio system

| Surface | Vendor / system | Notes |
|---------|-----------------|-------|
| SENS announcements | IRESS Pro `NewsHeadlineGet` (vendor=SENS) on the **prod seat** via `main-prod.ts` | **Prod worker wired 2026-07-22** — separate Railway service (`Dockerfile.prod` + `src/main-prod.ts`) opens its own IRESS production seat via `IRESS_MARKET_DATA_PROD=1` + `IRESS_MARKETDATA_BASE_URL=https://webservices.iress.co.za/v4`. Vendor-broadcast paginates `NewsHeadlineGet` (5-page cap, `PagingBookmark`, `Count` floored at 500, default 2000); auto-falls-back from `SENS` → `SENSD` on 25010/25018 with `payload.scope.vendor_fallback=true`. Each row is universe-tagged against `env.watchlistEntries` + `securities_c` + `oems_instrument_universe_c`. Per-loop pilot-write gate (`IRESS_NEWS_DRY_RUN=1` + `IRESS_NEWS_ALLOW_WRITES=0` default; opt-in `0/1` flips `news_item_c` writes — worker-wide gate stays dry-run). **No write to Supabase until the operator explicitly flips the per-loop gate.** UAT/CT worker (`main.ts`) untouched; both seats stay strictly isolated per `AGENTS.md` |
| News flow | IRESS Pro `NewsHeadlineGet` / `NewsVendorGet` on the prod seat | Default vendor is `SENS` (real-time) with `SENSD` (delayed) fallback; one-shot vendor catalog persisted to `news_item_c` as a synthetic `source="__catalog__"` marker row (`payload.scope.vendor_catalog`). BFF `/api/iress/news` accepts `?symbol=NPN` (per-symbol filter forwarded to `NewsHeadlineGet.SecurityCode`) and `?vendorCatalog=1` (returns entitled vendor list). Probe path (`/debug/news-vendor-probe`) widened in lockstep. UAT/CT worker's `SENSD` default unchanged for backward compat |
| Macro pulse (CPI, PMI, etc.) | Macro data vendor | Not in IRESS mock surface |
| Platform AUM / Day P&L | Portfolio / accounting system | Strategies are seed-only |
| PCA curve decomposition | Derived from live curve | Blocked on curve feed |
| Persona pages (`/wm`, `/strategist`, `/admin`, `/business`, `/fc`) | CRM / ops systems | All seed placeholders |
| Fundamentals on security page | Ref data vendor | Hardcoded today |
| Fixed income / money market / curves pages | IRESS + index vendors | Seed-only UI |

## Timeline estimate for 100% real

| Phase | Scope | Effort | Dependency |
|-------|-------|--------|------------|
| **Now** | Quotes for 10-symbol watchlist | Done | Railway worker LIVE + Supabase |
| **Week 1** | Orders in audit, worker health visible | Done (UI); worker writes need `SUPABASE_ALLOW_WRITES=1` | Account code from Charles |
| **Week 2** | Index + FX + JIBAR on worker watchlist | 2–3 days eng | IRESS symbol entitlement |
| **Week 3** | Sector indices + ALSI intraday | 3–5 days eng | `TimeSeriesGet2` entitlement |
| **Week 4+** | SENS, news, macro | Vendor selection + contract | External feed budget — SENS is now wired on the prod worker (2026-07-22); vendor catalog + universe tagging in place; per-loop pilot-write gate ready for opt-in flip |
| **Week 6+** | AUM/P&L, personas, fundamentals | Portfolio system integration | Business systems |

**100% real across every panel**: unlikely before **8–12 weeks** without parallel vendor onboarding; **quotes + orders + worker health** can be production-honest within **1–2 weeks** once Railway worker runs LIVE writes and Charles confirms BHG/sector entitlements.

## Charles / vendor action items

1. Confirm `BHG` board / quotation basis — CT returns hollow row today.
2. Provide sector index codes for JSE heatmap.
3. Confirm `OrderPadGetByAccount` account code for worker poll.
4. ~~Advise on SENS/news — IRESS path vs third-party.~~ **Resolved 2026-06-25** — `NewsVendorGet` confirmed; default `Vendor=SENS`. Adapter + probe + BFF wired; only the headline-vs-body entitlement + vendor exact-match are pending a live probe.
5. Entitlement check for `TimeSeriesGet2` on J203 and ZAR curve codes.
6. **NEW** — confirm `NewsVendorGet` entitlement on `DFM@Mint`, and whether the returned rows include story bodies or only headlines. Probe code is committed (default vendor switched to `IRESS` in `56a5c49`); the curl is now:
   ```bash
   curl 'https://iress-worker-production.up.railway.app/debug/news-vendor-probe?vendor=IRESS&pageSize=10&includeBody=1'
   ```
   **BLOCKED (2026-06-25):** the live probe returns `404 not_found` because the Railway `Iress-Worker` is still running commit `59ef104` (2026-06-22), which predates the probe route. The Railway GitHub app for `edgeza/Wealth-Navigator` is no longer installed, so the MCP `redeploy` re-uses the cached image. Operator action: re-install the Railway GitHub app for the `edgeza` org (https://railway.com/account/integrations), then push a new commit (or click "Deploy") to trigger a fresh build with `56a5c49`. Re-run the curl above once the build is `SUCCESS`. See `docs/ISSUES_LOG.md` § 0.5.1 for the verbatim response + unblock steps.

See also: `docs/DATA_PROVENANCE.md`, `docs/MINT_GO_LIVE_RUNBOOK.html`.
