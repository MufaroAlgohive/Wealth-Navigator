# Mint + Wealth Navigator Merge & Iress Standardization — Plan

**Status:** Plan / review-only. No code or live-data changes made yet.
**Authored:** 2026-06-19
**Owner decisions (2026-06-19):**
1. **Merge shape:** one Next.js app with route groups (fold Mint admin into `wealth-navigator`). Not a monorepo.
2. **Yahoo cutover:** move price + intraday + `change_percent` to Iress now and disconnect Yahoo for those; keep a **thin Yahoo job only** for the fields Iress can't supply yet (`market_cap`, `pe_ratio`, dividends, `ytd_performance`/returns) until Iress entitlements land, then remove.
3. **Scope now:** this document only. Review before any code or live-data work.

Related: `docs/DB_TOPOLOGY_DECISION.md`, `docs/STACK_ARCHITECTURE.md`, `docs/DATA_PROVENANCE.md`.

---

## 1. Goals

1. **Mint → React/Next.js.** Rebuild the Mint admin website (currently static HTML + bare Node server) as a full Next.js/React app on the same stack as wealth-navigator. No HTML pages.
2. **Merge the two websites** into one application and **remove Yahoo**, using Iress end-to-end *where possible*.
3. **Two databases, kept separate** (the retail DB is LIVE with real clients) — but Iress powers **both**, so the merged site reads only Iress-sourced data and Yahoo can be disconnected.

---

## 2. Current state

### 2.1 Wealth Navigator (target stack — keep & extend)
- Next.js 16 · React 19 · TS strict · Tailwind · shadcn/Radix · TanStack Query · Zustand · Bun.
- App-router pages under `src/app/` — institutional desk at `/oems/*` plus placeholder persona pages (`wm`, `strategist`, `business`, `admin`, `fc`).
- BFF API under `src/app/api/*` (orders, quotes, equities, indices, sectors, curves, money-market, fx, bonds, macro, news, portfolio, worker-health, integration/health, ticks SSE…).
- Supabase Auth via `@supabase/ssr` (`src/lib/supabase/{client,server,middleware}.ts`), split service-role clients for retail vs institutional.
- **Iress ingest worker** at `workers/iress-ingest/` on Railway: owns the single Iress CT license seat, polls quotes/orders/timeseries/IPS, writes to both DBs.
- Deploy: Vercel (app) + Railway (worker).

### 2.2 Mint Admin (`MIGRATION [delete when done]/MyMintAdmin-main` — to migrate)
- `mint-crm`: bare `node server.js` (`http.createServer`, no framework), deps only `pg` + `dotenv` (uses Supabase **PostgREST via raw `fetch`**, not `pg`).
- ~15 **static HTML** pages in `public/` + vanilla JS + **Tailwind via CDN**; routing = sequential `req.url.startsWith()` checks; default → static file serve.
- `api/*.js` Vercel functions for backend logic.
- In-process `setInterval` schedulers + one Vercel cron.
- Bespoke admin auth: Supabase JWT bearer token validated server-side, looked up against `admin_team`.
- Integrations: **Yahoo Finance** (market data), **SumSub** (KYC), **Resend** (email), **Supabase webhooks**.
- Deploy: Replit + Vercel.

**Feature areas (admin nav):** Clients · Client View Studio · Dashboard · Strategies · Factsheets · Investors · Order Book · EFT Payments · Mint Mornings · Emailers & Triggers · Settings · Team · Cyber Compliance. (+ auth: signin/signup/reset.)

---

## 3. Database topology (NOT merged)

Two production Supabase projects stay separate (compliance: institutional ≠ retail). Staging is a third, non-production validation project.

| DB | Project ref | Role | Provided schema |
|---|---|---|---|
| **RETAIL / LIVE** | `mfxnghmuccevsxwcetej` | Live client books, CRM, admin, compliance | **Schema #2** (profiles, loans, family, wallets, transactions, stock_holdings_c, strategies_c, securities_c rich, cc_*, pbc_*, email/mornings, admin_team) |
| **INSTITUTIONAL** | `nnwzhxfjpjbzujevwzlh` | OEMS desk + Iress worker output | **Schema #1** (oems_*, quote_snapshot_c, index/sector/yield_curve/bonds/money_market/jibar/macro/news, integration_worker_health, worker_session_metadata) |
| **STAGING** | (separate) | Validate Iress + migrations before prod | — |

The merged app reads both prods via the BFF (`createRetailServiceRoleClient()` / `createInstitutionalServiceRoleClient()`). The worker writes prices → retail, trading/analytics → institutional.

### 3.1 Schema collision to manage
`securities_c` and `stock_intraday_c` exist in **both** DBs with **different columns**:
- `securities_c`: institutional = minimal (id, symbol, name, last_price, sector, asset_type, ytd_start_price, currency, prev_close); retail = rich (+ exchange, logo_url, fundamentals, isin, collateral scoring, free_float, disqualified…).
- `stock_intraday_c`: institutional = (security_id, current_price, timestamp); retail = (+ symbol, 1d_pct, 1d_abs).

**Guardrail:** never assume one shape across DBs. Typed Supabase clients must be DB-specific. Document the canonical owner of each shared column.

---

## 4. Target architecture (single app)

One Next.js app (extend `wealth-navigator`) with route groups:

```
src/app/
  (institutional)/oems/*        # existing trading desk (unchanged)
  (admin)/admin/*               # NEW — Mint CRM surfaces (the 13 feature areas)
  login, login/forgot, signup   # Supabase Auth (replaces Mint's signin/signup/reset)
  api/*                         # BFF — existing + ported Mint endpoints
```

- **One auth system:** Supabase Auth (cookies + middleware), already in WN. Mint's bespoke bearer flow is replaced; RBAC continues to use `admin_team`/`admin_profiles` (`role`, `page_access`/`page_permissions`). Middleware gates `(admin)/*` by role.
- **One design system:** WN's Tailwind tokens + shadcn/Radix + glass primitives. Kill Tailwind CDN.
- **One BFF:** Mint's `api/*.js` become Next route handlers / server actions reading the **retail** DB; desk endpoints keep reading institutional.
- **Schedulers → Vercel cron** (or the Railway worker for market data). No in-process `setInterval`.

---

## 5. Data-source migration: Yahoo → Iress

### 5.1 Field-level map (the security master)
Legacy Yahoo job (`server.js → syncAllSecuritiesFromYahoo`, daily 07:00 SAST, 60s poll) PATCHes the security master with:

| Field | Iress coverage | Action |
|---|---|---|
| `last_price` | ✅ worker `retail-ingest` (gated) | Cut over now |
| `change_percent` | ✅ derivable (last vs prev_close) | Add small calc in worker |
| `market_cap` | ⚠️ needs Iress fundamentals (entitlement unverified) | **Keep thin Yahoo** until entitlement |
| `pe_ratio` | ⚠️ fundamentals | **Keep thin Yahoo** |
| `dividend_per_share`, `dividend_yield` | ⚠️ fundamentals | **Keep thin Yahoo** |
| `ytd_performance` | ⚠️ `TimeSeriesGet2` (entitlement-blocked 2026-06-13) | **Keep thin Yahoo** (or derive from `ytd_start_price`) |
| `stock_returns_c` (1d/5d/1m/6m/ytd/1y/5y) | ⚠️ `TimeSeriesGet2` | **Keep thin Yahoo/returns job** |
| `pbc_screen_results` (advt, vol_90d, mkt_cap) | ⚠️ `TimeSeriesGet2` + volume | Defer; depends on entitlement |

Also: `/api/security-performance` (Yahoo 5d/1mo chart) and WN `/api/global-movers` (Yahoo scrape, non-core).

### 5.2 Mechanism
- Iress already writes `securities_c.last_price` + `stock_intraday_c` + `quote_snapshot_c` via `workers/iress-ingest/src/retail-ingest.ts`, **shadow-gated** by `IRESS_RETAIL_INGEST=1` + `IRESS_RETAIL_DRY_RUN=0` + `RETAIL_SUPABASE_URL` (+ `RETAIL_PRICE_SOURCE_COL=1` to stamp `price_source`).
- Per decision #2: flip the gate for **price/intraday/change%**, disconnect Yahoo for those, and **shrink the Yahoo job to only the gap fields** (`market_cap`, `pe_ratio`, dividends, `ytd_performance`, returns). Remove the thin Yahoo job once Iress entitlements (`SecurityGet` fundamentals + `TimeSeriesGet2`) are enabled by Charles on `DFM@Mint`.

---

## 6. Phased plan

### Phase 0 — Foundations (no live-data risk)
- Confirm merge structure & branch strategy; bring Mint admin onto WN's split env (`RETAIL_*` / `INSTITUTIONAL_*`).
- Apply the (already-written) review-only `supabase/retail/20260614_add_price_source.sql` to `mfxng` in the SQL editor.
- Build a **parity checklist** of all 13 areas + auth + every `api/*.js` endpoint + every scheduler.
- **Acceptance:** checklist signed off; envs resolve; migration applied.

### Phase 1 — Data layer (de-risk live data first)
1. **Identify the existing ~15s writer** of `mfxng.stock_intraday_c` (documented cutover pre-req) and plan its handover/disable.
2. Run `retail-ingest` in **shadow** (`IRESS_RETAIL_DRY_RUN=1`); validate symbol coverage + cents scaling vs current `last_price`.
3. Flip to **live writes** on `mfxng` (`last_price` + `stock_intraday_c`), stamping `price_source='iress'`. Add derived `change_percent`.
4. **Shrink the Yahoo job** to gap fields only; stop Yahoo for price/intraday.
- **Risks:** live customer pricing; single CT seat (don't run live locally while Railway holds it); scale/units mismatches. **Acceptance:** Iress-sourced prices match expected within tolerance; no stale rows; Yahoo no longer writes price/intraday.

### Phase 2 — Platform for the merge (mostly additive code)
- Create `(admin)/*` route group, nav, layout reusing WN tokens/components.
- Wire Supabase Auth + `admin_team` RBAC middleware for `(admin)/*`.
- Port `api/*.js` → Next route handlers / server actions (see §7.2); move schedulers to **Vercel cron** (orderbook `0 16 * * *`, mint-mornings, health-check 15-min) or the worker.
- **Acceptance:** admin shell loads behind auth; ported endpoints pass parity tests against legacy.

### Phase 3 — Port the 13 pages (HTML → React, vertical slices)
- Rebuild each area as React + BFF + TanStack Query. Suggested order (low-risk read-only → write-heavy): Cyber Compliance → Team → Settings → Clients → Investors → Strategies → Factsheets → Dashboard → Client View Studio → Mint Mornings → Emailers & Triggers → Order Book → EFT Payments.
- **Acceptance:** each ported page matches legacy behavior (parity checklist) and uses only Iress-sourced market data.

### Phase 4 — Cutover & decommission
- `security-review` (live PII / financial / KYC). Verify each surface vs legacy.
- Remove Yahoo entirely once entitlements land; remove thin Yahoo job.
- Retire Replit Mint app; delete the `MIGRATION [delete when done]/` folder; update docs.
- **Acceptance:** single app serves both desks; Yahoo disconnected; legacy app off.

---

## 7. Migration inventories

### 7.1 Pages → primary data (retail DB unless noted)
| Legacy page | New route | Data |
|---|---|---|
| signin/signup/reset | `/login`, `/signup`, `/login/forgot` | Supabase Auth |
| index.html (Clients) | `/admin/clients` | `profiles`, computershare |
| studio.html (Client View Studio) | `/admin/studio` | `/api/studio-config`, client portfolio |
| dashboard.html | `/admin/dashboard` | `strategies_c`, securities/quotes |
| strategies.html | `/admin/strategies` | `strategies_c`, `strategies_returns_c` |
| factsheet(s).html | `/admin/factsheets` | `strategies_c` + returns |
| investors.html | `/admin/investors` | `/api/investors/data` (holdings, returns, txns, fees, drawdowns, rebalance) |
| orderbook.html | `/admin/order-book` | `stock_holdings_c`, `securities_c`, `orderbook_email_runs` |
| eft.html | `/admin/eft` | `wallets`, `transactions`, `wallet_transactions` |
| mint-mornings.html | `/admin/mint-mornings` | `News_articles`, `mint_mornings_*`, `email_templates` |
| emailers.html | `/admin/emailers` | `email_templates`, `email_webhook_triggers`, `email_campaigns`, `email_queue` |
| settings/app-settings.html | `/admin/settings` | `app_settings` |
| team.html | `/admin/team` | `admin_team`, `admin_team_audit` |
| cyber-compliance.html | `/admin/cyber-compliance` | `cc_incidents`, `cc_uptime_log`, `cc_api_health`, `cc_policy_checks`, `cc_audit_log` |

### 7.2 Legacy `api/*.js` → Next
| Legacy | New | Notes |
|---|---|---|
| `team.js`, `_team.js` | `/api/admin/team` + actions | Supabase auth + `admin_team` RBAC + Resend invites |
| `sumsub/*`, `_sumsub.js` | `/api/kyc/sumsub/*` | HMAC server-side; image/metadata/archive |
| `webhooks.js` | `/api/webhooks/supabase` | welcome / KYC emails (secret-gated) |
| `send-eft-email.js` | `/api/eft/*` + action | wallet top-ups, child accounts, txn logging |
| `mint-mornings.js` | `/api/mint-mornings` + cron | news digest → Resend |
| `cyber-compliance.js` | `/api/cyber-compliance` | admin-only incidents/health/policy |
| `investors/data.js` | `/api/investors/data` | CORS read; consider folding into portfolio BFF |
| `monitor/_health-check.js` | `/api/monitor/health-check` + cron (15m) | writes `cc_*` |
| `orderbook/*`, `_orderbook.js` | `/api/orderbook/*` + cron (`0 16 * * *`) | CSV + archive + price stamp |
| `_email-logger.js` | shared lib | `email_logs` audit |

### 7.3 Schedulers → cron
`startMarketDataScheduler` (Yahoo) → worker + thin Yahoo cron · `startDailyOrderbookScheduler` → Vercel cron · `startMintMorningsScheduler` → Vercel cron · `startHealthCheckScheduler` → Vercel cron (15-min).

---

## 8. Risks & guardrails
- **Live customer DB (`mfxng`).** All writes reviewed; migrations operator-pasted (worker never applies DDL). Shadow-validate before live.
- **PII / KYC / financial data.** Mandatory `security-review` before cutover; keep SumSub HMAC + Resend keys server-side; never in `NEXT_PUBLIC_*`.
- **Single Iress CT seat.** Don't run live Iress locally while Railway holds the seat; proper logout sequence on release.
- **Entitlement blockers.** Fundamentals + `TimeSeriesGet2` gate the full Yahoo removal — track with Charles (`DFM@Mint`).
- **Schema collision.** DB-specific typed clients; document canonical column owners.
- **Realtime/quotes writer handoff.** Resolve the existing `mfxng.stock_intraday_c` writer before worker takeover.

## 9. Open dependencies
1. Charles to enable Iress `SecurityGet` fundamentals + `TimeSeriesGet2` on `DFM@Mint` (unblocks full Yahoo removal).
2. Identify/own the current ~15s `mfxng.stock_intraday_c` writer.
3. Confirm whether `/api/global-movers` (Yahoo) is kept or dropped.

## 10. Tooling / skills per phase
- Planning: `Plan` agent + plan mode; `Workflow` multi-agent for the large HTML→React sweep (opt-in).
- UI port: `ui-ux-pro-max`, `ui-styling` (shadcn/Radix), magic component MCP.
- Quality: `security-review` (required), `verify`, `run`, `code-review`.
- Memory: native memory files + `consolidate-memory` as the project evolves.
