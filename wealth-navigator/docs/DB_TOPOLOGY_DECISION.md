# Database Topology Decision — Mint / Wealth Navigator

> **Status: DECIDED — 2026-06-13.** This is the authoritative production data-architecture decision.
> **Supersedes:** [`TWO_DATABASE_STRATEGY.md`](TWO_DATABASE_STRATEGY.md) and [`TWO_DB_STRATEGY.md`](TWO_DB_STRATEGY.md) (useful background; where they conflict, this doc wins).
> **Driver:** IRESS is the source of truth for all market + trading data; a hard **compliance** requirement mandates that **institutional and retail data live in separate databases**.

---

## 1. The decision

Production runs on **three Supabase databases**, with **IRESS V4 as the upstream source of truth** (via the Railway `Iress-Worker`):

| Role | Project ref | Holds | Writer |
|---|---|---|---|
| **Retail prod** | `mfxnghmuccevsxwcetej` | Retail customer books (profiles, wallets, holdings, KYC, strategies_c, gifts, loans, funeral) **+ shared price tables** `securities_c` / `stock_intraday_c` | Consumer app (customer data) + IRESS worker (prices) |
| **Institutional prod** | `nnwzhxfjpjbzujevwzlh` *(promoted from the IRESS-test DB)* | Desk **trading book** (orders, positions, bookings, account cash, FIX+) **+ desk-only market analytics** (curves, indices, sectors, macro, news, bonds, money-market) | IRESS worker |
| **Staging** | *fresh project (to create)* | Schema-mirror of **both** prods — validate IRESS calls + migrations before they touch prod | IRESS worker (staging mode) |

```
                IRESS V4  (source of truth, via Railway worker)
                 │                              │
   market prices │                              │ trading book + desk analytics
                 ▼                              ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ RETAIL PROD   mfxnghmuccevsxwcetej│   │ INSTITUTIONAL PROD  nnwzhx…       │
│ • customer books: profiles,       │   │ • desk trading book: oems_order_  │
│   wallets, stock_holdings_c, KYC, │   │   audit, oems_position_c,         │
│   strategies_c, gifts, loans,     │   │   oems_transaction_c, oems_       │
│   funeral, transactions           │   │   account_c, bookings, FIX+       │
│ • SHARED market data:             │   │ • desk-only analytics: curves,    │
│   securities_c, stock_intraday_c  │   │   indices, sectors, macro, news,  │
│   (IRESS worker writes prices)    │   │   bonds, money-market             │
└──────────────────────────────────┘   └──────────────────────────────────┘
                 ▲                                          ▲
                 └────────── WN Vercel BFF reads both ──────┘
                 (market+customer from retail · trading+analytics from institutional)

  STAGING (fresh project) — schema-mirror of both; IRESS + migrations validated here first
```

---

## 2. Data-source map

Source of truth is either **IRESS** (live, via worker) or **retail prod** (`mfxng…`, consumer-owned).

### Market data — IRESS is source of truth
| Data | IRESS method | Lands in | Status |
|---|---|---|---|
| Equity L1 quotes/prices (`securities_c`, `stock_intraday_c`) | `PricingQuoteGet`(+Updates) | **Retail prod** | ✅ live (10-symbol universe; CT row-shape handled) |
| L2 depth / time-&-sales | `PricingQuoteExGet` (L2 TBC) | Institutional prod | ⚠️ method/entitlement unconfirmed → ask Charles |
| Intraday index (J203/ALSI) | `TimeSeriesGet2` | Institutional prod (`index_intraday_c`) | ⛔ blocked (Frequency entitlement) |
| Sector heatmap | `TimeSeriesGet2` | Institutional prod (`sector_intraday_c`) | ⛔ blocked |
| ZAR curves (govi/NSS/real/breakeven) | `TimeSeriesGet2` | Institutional prod (`yield_curve_history_c`, `oems_curve_metric_c`) | ⛔ blocked |
| Money market (JIBAR/ZARONIA, NCD/T-bill) | `TimeSeriesGet2` | Institutional prod | ⛔ blocked |
| Bonds reference + analytics (YTM/DV01/convexity) | `PricingQuoteGet` + computed | Institutional prod (`bonds_c`) | partial (analytics computed) |
| Macro (SARB/StatsSA/G10) | `TimeSeriesGet2` | Institutional prod | ⛔ blocked |
| News / SENS | IRESS news/SENS (delivery TBC) | Institutional prod (`news_item_c`) | ⚠️ delivery unconfirmed → ask Charles |

### Trading / desk — IRESS is source of truth (IOS+ / IPS)
| Data | IRESS method | Lands in | Status |
|---|---|---|---|
| Working/filled/cancelled orders | `OrderPadGetByAccount`(+Updates) | Institutional prod (`oems_order_audit`) | wired (needs IOS+ session + account codes) |
| Place / amend / cancel | `OrderCreate3` / `OrderAmend2` / `OrderDelete` | → IRESS, mirrored to audit | wired via worker; `OrderTag` idempotency |
| Fills / fees | `BookingGetByOrganisation2` (MiscFees) | Institutional prod (bookings) | designed |
| Positions / transactions | `IPSPositionGetAll1` / `IPSTransactionGetByAccount5` | Institutional prod (`oems_position_c`, `oems_transaction_c`) | wired |
| Account cash | `IPSAccountGetAll1` | Institutional prod (`oems_account_c`) | designed |
| FIX+ drop-copy status | `TargetIDGet` / `TargetIDStatusGet` | Institutional prod | designed |

### Customer / account — retail prod (`mfxng…`) is source of truth
| Data | Source table(s) | Notes |
|---|---|---|
| Client identity, `mint_number` | `profiles` | join key ↔ IRESS `AccountCode` |
| KYC status | `user_onboarding`, `required_actions` | sensitive |
| Retail model portfolios + returns | `strategies_c`, `strategies_returns_c`, `strategy_metrics` | distinct from desk `oems_strategy_c` |
| Per-client retail holdings & P&L | `stock_holdings_c`, `user_strategies`, `client_strategy_returns_c` | sensitive |
| Wallet / cash ledger | `wallets`, `transactions` | sensitive |
| Goals / gifts / family | `investment_goals`, `gift_claims`, `family_members` | |
| Banking / credit / insurance | `truid_*`, `loan_*`, `credit_*`, `insurance_policies` | highly sensitive |

**Join keys:** market data ↔ by `symbol`; client ↔ desk by `mint_number` ↔ IRESS `AccountCode` (bridge **deferred past OEMS v1**).

---

## 3. Why this topology (reconciling the two constraints)

The two stated requirements appear to conflict — *"single prod DB for the rest of the data"* vs *"institutional and retail must be in separate DBs for compliance."* They reconcile once you recognise **market/reference data is neither retail nor institutional "books and records"** — it is shared price data. Compliance cares about *books* (positions, orders, cash, customer PII), not the price feed.

- ✅ **Compliance** — the institutional trading book is in a *separate database* (`nnwz…`) from retail customer books (`mfxng…`).
- ✅ **"Rest of the data from `mfxng…`"** — all customer data + the shared price tables stay there; nothing customer-facing moves.
- ✅ **IRESS = source of truth** — the worker writes prices into retail prod and the trading book + desk analytics into institutional prod (two service-role clients).
- ✅ **Test DB retired** — `nnwz…` is promoted from throwaway IRESS-test to institutional prod; a fresh staging project takes over validation.
- ✅ **No cross-DB mirror** — the shared price tables live where the retail app already reads them; the split falls on a real seam, not an arbitrary copy.

Cost imposed by compliance: the worker writes to two prod DBs, and the WN BFF reads from two prods + live IRESS. Both are within what the worker/BFF already support.

---

## 4. Cutover runbook

> All migrations remain **review-only + user-pasted** in the Supabase SQL editor. The worker never auto-applies DDL. SQL must be idempotent.

**Phase 0 — Capture & pre-reqs (now)**
- [x] Record this decision (this doc + `AGENTS.md`; mark the two `TWO_DB*` memos superseded).
- [ ] **CRITICAL:** identify the existing ~15s writer of `stock_intraday_c` in `mfxng…` (retail prod) — TABLES.md says it refreshes every ~15s today. The IRESS worker must **replace**, not race, it.
- [ ] Confirm `profiles.mint_number` is populated + `UNIQUE` (present in the pasted schema) — for the future client↔account bridge.

**Phase 1 — Stand up fresh staging**
- [ ] Create a new Supabase project (e.g. `wealth-navigator-staging`).
- [ ] Apply the full OEMS migration set there (idempotent).
- [ ] Point a staging worker at it (`IRESS_MODE=live` or `wsdl-stub`); validate quote ingest, order poll, IPS.
- [ ] This becomes the home for IRESS experiments — including the `TimeSeriesGet2` `Frequency`-vs-`Interval` fix.

**Phase 2 — Harden `nnwz…` → institutional prod**
- [ ] Scrub test/seed data from `nnwz…`.
- [ ] Harden RLS: service-role writes only; operator-read policies; deny anon.
- [ ] Relabel the project to an institutional-prod identity (avoid the "MyMint test" naming that caused the two-"production" confusion).
- [ ] Re-point the production worker's **institutional** client at `nnwz…` (trading book + desk analytics).

**Phase 3 — Market data into retail prod**
- [ ] Resolve the existing `stock_intraday_c` writer (Phase 0) — replace or explicitly coexist.
- [ ] Add the worker's **retail** Supabase client → `mfxng…` for `securities_c` / `stock_intraday_c` only, **symbol-mapped** (per-project `security_id` differs — match by `symbol`), **dry-run first**, **only symbols already in the retail catalogue**.
- [ ] Verify the retail app still values portfolios correctly with IRESS-sourced prices.

**Phase 4 — WN Vercel BFF dual-source**
- [ ] BFF reads market+customer from retail prod, trading+analytics from institutional prod.
- [ ] DataSource badges reflect which DB + IRESS liveness.

**Phase 5 — Unblock `TimeSeriesGet2` (parallel track)**
- [ ] Switch the wire field `Interval` (string) → `Frequency` (Long) and find the accepted enum, and/or get Charles to enable the entitlement on `DFM@Mint`. Unblocks curves, indices, sectors, macro, money-market. See `docs/TIMESERIES_PROBE_REPORT.md`.

---

## 5. Env var plan (worker + Vercel)

Today the worker/Vercel use a single `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. Split into named targets:

| Var | Points at |
|---|---|
| `RETAIL_SUPABASE_URL` / `RETAIL_SUPABASE_SERVICE_ROLE_KEY` | `mfxng…` (prices write; customer read) |
| `INSTITUTIONAL_SUPABASE_URL` / `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` | `nnwz…` (trading book + analytics) |
| `STAGING_SUPABASE_*` | fresh staging project (non-prod only) |

Server-side only — never `NEXT_PUBLIC_*`, never committed. Set in Railway (worker) and Vercel (BFF).

---

## 6. Deferred (not in OEMS v1)

- **Client↔account bridge** — `mint_number` ↔ IRESS `AccountCode` link + BFF gateway so operators can see a customer's KYC/holdings against IRESS accounts. Deferred until trading is solid.
- **Consumer-app market-data migration** — the retail app already reads `securities_c`/`stock_intraday_c`; once IRESS is the proven writer, the consumer app's old price pipeline can be retired.
