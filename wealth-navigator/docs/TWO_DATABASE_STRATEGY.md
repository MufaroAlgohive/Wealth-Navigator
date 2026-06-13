# Two-Database Strategy — Mint Consumer + Mint OEMS / Wealth Navigator

> **⚠️ SUPERSEDED (2026-06-13) by [`DB_TOPOLOGY_DECISION.md`](DB_TOPOLOGY_DECISION.md).** Final decision is a **3-database** topology (retail prod `mfxng…` / institutional prod `nnwz…` promoted from test / fresh staging), driven by a hard compliance requirement that institutional and retail data live in separate DBs. This memo's "keep separate, bridge via `mint_number`, defer" analysis remains useful background; where it conflicts with the decision doc, the decision doc wins.
> **Status (original):** Draft strategy memo for the user's review. Strategy only — no migrations or code changes proposed beyond planning.  
> **Author:** data-architecture strategist  
> **Date:** 2026-06-13  
> **Projects in scope:**
> - **Consumer (Mint app):** `https://mfxnghmuccevsxwcetej.supabase.co` — the Lovable-built retail investment app that has been live with real users, KYC, banking links, gifts, P&L. Referred to below as the **consumer DB** / **"old Mint"** / the **Eververse** project in earlier notes.
> - **OEMS / Wealth Navigator (MyMint):** `https://nnwzhxfjpjbzujevwzlh.supabase.co` — the institutional trading-desk project this repo builds against. Has 4 pending migrations to be pasted. Referred to below as the **OEMS DB** / **"new Mint"** / **MyMint**.
> **Also refer to:** `docs/STACK_ARCHITECTURE.md` §1 (Vercel + Supabase + Railway topology), `docs/DATA_PROVENANCE.md` (Path A vs Path B), `docs/ISSUES_LOG.md` §2.10 (Vercel + Railway `SUPABASE_URL` parity), `AGENTS.md` (the standing rules about IRESS creds and the OEMS-first project).

---

## 0. TL;DR (read this first)

**Recommendation: B — keep the two Supabase projects separate, cross-reference by stable `mint_number` / IRESS `AccountCode`, and route OEMS reads of consumer data through a thin server-side gateway.** The consumer app has been running in production with real KYC, banking links, and user balances — moving it to a new project (`nnwzhxfjpjbzujevwzlh`) is a high-risk, high-effort data migration that we do not need to do *right now*, and the only thing the OEMS actually needs from the consumer side is "given a `mint_number`, give me that client's name, KYC status, and a stable ID I can join on." That is a one-route BFF problem, not a database problem. **Merging (Strategy A)** is the wrong answer because we would have to rebuild a working consumer app on a project we do not yet fully control, and **the hybrid mirror (Strategy C)** turns the consumer DB into a read-only source of truth that we still have to *write* to from the OEMS side — a synchronization problem we already have a better solution for (IRESS is the upstream source of truth for positions, and the consumer can keep its existing wallet/balance schema). Pick B, do it in v1, defer cross-DB real-time triggers to v2.

> ⚠️ **SECURITY INCIDENT IN §6 — rotate the consumer project's service-role key NOW. It was pasted in chat.** The anon key is also exposed; treat both as compromised. See §6 for the exact JWT to invalidate and the Supabase steps to rotate.

---

## 1. Context

The user maintains **two Supabase projects** that both hold parts of the Mint business:

| Project | URL | Audience | Status | Schema lead |
|---|---|---|---|---|
| **Consumer (Lovable-built, "old Mint")** | `mfxnghmuccevsxwcetej.supabase.co` | End-users — retail Mint investors, gift-senders, KYC'd individuals | **Production, live, real money, real users** | Lovable-era schema, the user described `profiles`, `transactions`, `securities_c`, `stock_holdings_c`, `strategies_c`, `gift_claims`, plus KYC and banking-link tables |
| **OEMS / Wealth Navigator (MyMint, "new Mint")** | `nnwzhxfjpjbzujevwzlh.supabase.co` | Desk operators, relationship managers, compliance — the institutional trading surface | **Pre-production** — Railway IRESS worker is talking to IRESS CT and writing snapshots, but the new `oems_*` tables are still empty until the 4 pending migrations are pasted | This repo, `wealth-navigator/supabase/migrations/` |

The two projects **already overlap in table names** — `securities_c`, `strategies_c`, `stock_intraday_c` (and probably `stock_holdings_c`) appear on both sides. That is the surface of the question: are we going to make them **one** database, two, or one-database-with-a-derived-mirror?

The consumer app's *system of record* for user identity, KYC, banking, gifts, and wallet balance is itself. The OEMS's *system of record* for orders, audit, quotes, instrument metadata, IPS positions is IRESS (via the Railway worker). **The only thing the OEMS truly needs from the consumer is "who is this client?"** — and a stable, immutable join key for it.

---

## 2. Full schema mapping — consumer tables vs OEMS equivalents

> The OEMS column reflects the **state of `nnwzhxfjpjbzujevwzlh` after all 14 existing migrations + the 4 pending migrations the user has not yet pasted** (i.e., the world the user is about to create). Consumer-side table shapes are inferred from the user's description; the precise Lovable-era schema for `profiles` / `wallets` / `stock_holdings_c` / `strategies_c` / `gift_claims` / banking / KYC should be confirmed by reading the consumer DB's `information_schema` before any work begins.

| Consumer table (Lovable / `mfxnghmuccevsxwcetej`) | OEMS equivalent (MyMint / `nnwzhxfjpjbzujevwzlh`, after pending migrations) | Recommendation | Rationale |
|---|---|---|---|
| `profiles` (user id PK, name, email, phone, KYC status, role) | None in OEMS. The OEMS operator signs in via OEMS's own Supabase Auth (`mint-auth` cookie today; Supabase Auth JWT in prod per `AGENTS.md`). Consumer-user identity is *external* to OEMS. | **Leave as-is on the consumer side; reference by `mint_number` (consumer `profiles.id` or a stable `mint_number` column) from OEMS.** | The OEMS is an operator/RM surface. Operators have OEMS identities (`auth.users` in MyMint), not consumer identities. The mapping is `oems_account_c.beneficiary_mint_number` → consumer `profiles.mint_number` or `id`. |
| `wallets` (`balance` in **Rands**) | `oems_account_c` (`nav_value` and `cash_balance` in **currency-native**, not cents — see `20260613000001_oems_ips_portfolio.sql`). | **Separate.** Different source of truth. | The consumer's `wallets.balance` is the *cash wallet* (ZAR deposit balance, internal ledger, in Rands). The OEMS's `oems_account_c.cash_balance` is the IRESS IPS brokerage cash component (currency-native). They will **rarely** agree — the consumer wallet is pre-brokerage, the IRESS account is post-deposit. Joining them at the row level is wrong; instead the OEMS BFF renders "client X — wallet ZAR 12 400 / IRESS account ZAR 11 850" as two separate KPIs. |
| `transactions` (consumer deposit / withdrawal / gift ledger) | None in OEMS. | **Leave as-is on the consumer side.** | The consumer ledger is the *client's view* of money movement. The OEMS's *trade* ledger is `oems_order_audit` (IRESS side) + future `oems_transaction_c` (IPS side). The two ledgers are *reconciled* by the operator, not *joined* in the DB. |
| `securities_c` (consumer instrument ref) | `securities_c` (OEMS instrument ref — pre-existing on MyMint + the new `prev_close` column from `20260612000005_...`) | **Conflict — keep separate; the OEMS one is the source of truth for the trading desk.** | Both projects call it `securities_c` but they have *different* shapes: the consumer one is Lovable-era retail data (probably with consumer-only fields), the OEMS one is the IRESS-entitled instrument master (RIC, exchange, asset_type, sector, last_price, prev_close, and the worker-sync shape). **They are not the same table.** The trading desk's prices and instruments come from IRESS, not from the consumer DB. The OEMS `securities_c` is what the worker populates and the BFF reads; the consumer's is what the retail UI displays. If the OEMS ever needs to display "the consumer app's `securities_c` name for ticker NPN", it is a 50-line view join, not a database merge. |
| `stock_holdings_c` (consumer holdings, `market_value` in **cents**) | `oems_position_c` (OEMS positions, `market_value` **currency-native** — see `20260613000001_...`) | **Separate.** Unit mismatch. | Consumer `stock_holdings_c.market_value` is in cents (× 100). OEMS `oems_position_c.market_value` is currency-native (Rands, not cents). Even after a unit-alignment migration, the *source of truth* differs: consumer-side is the user-claimed/reported view (Lovable-era, may include JSE-listed securities held via other brokers or manual entry); OEMS-side is the IRESS IPS view (the brokerage's own position ledger). They are reconciled at the *operator* level, not at the row level. |
| `strategies_c` (consumer "what strategy am I on" — invested / savings / etc.) | `oems_strategy_c` (OEMS per-strategy rollup, AUM / P&L / status / asset class — see `20260613000002_...`) | **Separate, different shape, different purpose.** | Consumer `strategies_c` is *the user's chosen strategy bucket* (a UX affordance, a way to slice their own holdings). OEMS `oems_strategy_c` is *a firm-managed mandate* with AUM, day P&L, MTD P&L, and a manager. A consumer "I'm on the SA Equity Core strategy" should become a row in `oems_strategy_c.investor_count` incrementing, but the *consumer* row is the engagement state, not the firm mandate. **Cross-reference only.** |
| `gift_claims` (consumer gift-flow claim ledger) | None in OEMS. | **Leave as-is on the consumer side.** | The OEMS does not handle gifts; that is a consumer-app feature. The OEMS might want a *counter* of "how much gift value has this client received" but that is a BFF read against the consumer DB, not a table in OEMS. |
| KYC tables (consumer) | None in OEMS. Operators have OEMS-side KYC if/when compliance adds it (separate concern). | **Leave as-is on the consumer side.** | KYC is *per end-client*, not per operator. The OEMS looks up "is this client KYC'd?" by calling a BFF route that reads consumer KYC, not by re-storing KYC in OEMS. |
| Banking-link tables (consumer) | None in OEMS. | **Leave as-is on the consumer side.** | Banking links belong to the consumer's deposit/withdrawal flow, not to the brokerage. |
| `auth.users` (consumer identity) | `auth.users` (OEMS identity) | **Separate auth domains.** | This is the killer for Strategy A. Two Supabase projects have two `auth.users` tables with two separate JWT signers, two separate `goTrue` instances, and two separate MFA configs. The OEMS operator signs in on MyMint, not on the consumer project. A consumer end-user does **not** log in to the OEMS at all in v1. |
| `stock_intraday_c` (if the consumer has one) | `stock_intraday_c` (OEMS — populated by the Railway worker every 15s) | **Conflict — keep separate; OEMS is the source of truth for trading-desk prices.** | Same logic as `securities_c`. The OEMS worker writes the canonical JSE quote series; the consumer app either reads the OEMS read-replica (via BFF) or has its own ingestion (less likely). If the consumer is also pulling retail-grade prices, that is a separate ingest decision. |
| `integration_worker_health` (OEMS only) | n/a | **No conflict.** | OEMS-only. The consumer has no IRESS worker. |
| `oems_account_c` / `oems_position_c` / `oems_transaction_c` | n/a | **No conflict.** | OEMS-only. The consumer has no IRESS IPS data. |
| `oems_strategy_c` / `oems_curve_metric_c` / `bonds_c` / `jibar_fixing_c` / `money_market_instrument_c` / `macro_indicator_c` / `macro_release_c` / `news_item_c` / `oems_instrument_universe_c` | n/a | **No conflict.** | OEMS-only tier 5 / tier 6 / mandate tables. |
| `oems_order_audit` | n/a | **No conflict.** | OEMS-only audit mirror. |
| `worker_session_metadata` / `worker_recent_events` (in `integration_worker_health.metadata.recent_events`) | n/a | **No conflict.** | OEMS-only IRESS seat recovery. |
| `index_intraday_c` / `yield_curve_history_c` / `sector_intraday_c` | n/a | **No conflict.** | OEMS-only tier-2 series. |
| `securities_with_latest_quote` (OEMS view) | n/a | **No conflict.** | OEMS-only helper view. |

**Summary of conflict surface:**

- **True name collisions** where the OEMS table has *evolved past* the consumer's: `securities_c`, `stock_intraday_c`, `strategies_c` (vs `oems_strategy_c`). Resolution: leave the consumer's alone, use the OEMS's as the trading-desk source of truth, and route the consumer UI through the OEMS read-replica (BFF) if/when it needs IRESS-grade prices.
- **Concept collisions** where the names differ but the domains overlap: `stock_holdings_c` (consumer) vs `oems_position_c` (OEMS); `wallets` (consumer, Rands) vs `oems_account_c.cash_balance` (OEMS, currency-native). Resolution: **do not merge; reconcile at the operator view.**
- **Auth domain collision** (`auth.users` in both): the dealbreaker for Strategy A. Resolution: OEMS operators have OEMS identities; consumer end-users do not log in to OEMS at all in v1.
- **No real conflict** for ~80% of the tables (the OEMS has 18+ tables the consumer has nothing like, and the consumer has ~6 tables the OEMS has no business with).

---

## 3. The three strategies — honest comparison

### A. Merge the consumer DB into `nnwzhxfjpjbzujevwzlh`

**Move all consumer data into MyMint; deprecate the old `mfxnghmuccevsxwcetej` project.** This is the "single source of truth" dream.

| Cost | Risk | Benefit |
|---|---|---|
| **High** — full schema reverse-engineering of the Lovable-era consumer tables (RLS, triggers, grants, RLS-dependency-on-`auth.users`); backfill of `profiles`, `transactions`, KYC, banking links, gift claims; re-pointing the consumer app's `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`; re-issuing auth sessions to all live users (MFA reset if the auth domain changes); data export from old project, import to new | **Very high** — *downtime* on a live consumer app with real money and real KYC is a regulator-eyebrow-raiser; the consumer app's RLS almost certainly depends on `auth.uid() = ...` against the *old* `auth.users`, and we cannot seamlessly migrate that without an auth cutover; RLS policy audit, every consumer-side RLS policy re-tested; new `auth.users` = new UUIDs unless we use `--import` style migration (which Supabase does not natively support across projects); **financial-services data migration** is the kind of work that gets reviewed by compliance, not the kind we do over a long weekend | **Theoretical** — one auth domain, one set of RLS, one Supabase project to pay for, one mental model |

**Verdict: A is the wrong answer.** The consumer app is *running in production with real users and real money*. We should not rip it out of its project, change its auth domain, and re-issue sessions to every active user, **just to satisfy a tidy schema diagram** in the OEMS. The cost and risk are enormous, the benefit is a one-mental-model win, and the OEMS does not actually need the consumer's `transactions` table or its KYC blob in its own DB — it needs a `mint_number` lookup. **Reject A.**

### B. Keep separate, cross-reference by stable `mint_number` / IRESS `AccountCode` ✅ RECOMMENDED

**Two Supabase projects, two auth domains, two service-role keys, two project URLs.** The OEMS BFF exposes a small set of "consumer gateway" routes that read consumer data *as needed*; the OEMS worker writes IRESS snapshots into MyMint; the consumer app keeps working untouched.

| Cost | Risk | Benefit |
|---|---|---|
| **Low** — one new BFF route (`/api/consumer/[mint_number]`) and one new server-side Supabase client targeting the consumer URL; one new Vercel env var (`CONSUMER_SUPABASE_URL` + `CONSUMER_SUPABASE_SERVICE_ROLE_KEY`); one new RLS-friendly read policy on a single consumer view (or a Postgres view that exposes only the safe fields); ~3 days of engineering | **Medium** — *two service-role keys to manage* (a key management concern we already live with for Vercel + Railway); cross-DB queries become "fetch from B, then fetch from C" not a SQL JOIN (acceptable for an operator UI that renders one client at a time); if the consumer DB is offline, the OEMS operator view of the client name degrades (graceful — "client ID `M-00041`" still works without name lookup) | **Huge** — **zero downtime on the consumer app**; no auth migration; no RLS rewrite; the OEMS goes live on the schedule we already have (Charles's IRESS entitlement, the worker's LIVE writes); we can ship the OEMS MyMint pending migrations this week, and we can route the consumer-app's *future* retirement to MyMint *after* the OEMS is stable in production (i.e., this is reversible, A is not) |

**Auth boundary:** OEMS operators sign in on MyMint. Consumer end-users do **not** sign in to the OEMS at all in v1. When the OEMS renders a client blotter, it does a `mint_number` lookup against the consumer DB via a server-side BFF route (using the consumer service-role key server-side, never the anon key, and never with the anon key in the browser). When the consumer app *also* wants to render the OEMS-grade `stock_intraday_c` last price for a security the user holds, the consumer app hits the OEMS read-replica via a BFF route that uses the *OEMS* anon key (or a read-only scoped key) — but **not** the OEMS service-role key. The auth-domain split is a feature, not a bug: it means a compromise of the OEMS anon key does not leak the consumer's KYC, and vice versa.

**Unit/currency alignment:** **Not necessary at the database level.** The OEMS `oems_account_c.cash_balance` is currency-native (Rands) and the consumer `wallets.balance` is Rands — they happen to be the same unit, so the BFF can sum them with a *display* join in TypeScript. The OEMS `oems_position_c.market_value` is currency-native (Rands), the consumer `stock_holdings_c.market_value` is in cents — that is a *display* conversion (`market_value / 100`), not a database merge. **We can render the operator view of "client X has wallet ZAR 12 400 + IRESS ZAR 11 850 + positions MTM ZAR 487 200" by calling two BFFs and a `Number(x).toLocaleString()` — no schema change to either DB.**

**Verdict: B is the right answer.** It is the lowest cost, lowest risk, and the only strategy that does not require a risky consumer-app cutover. The auth-domain split is annoying but it is a problem we *already have* (Vercel + Railway already have two service-role keys to manage, per `AGENTS.md`); adding the consumer project's service-role key as a third is one more line in the env, not a new problem class. The OEMS goes live on the existing schedule; the consumer-app can be re-platformed onto MyMint *later* if and only if we want to, with no rush.

### C. Hybrid mirror — worker SELECTs consumer DB into OEMS read-model

**Keep consumer data where it is, but the Railway worker (or a new Railway consumer-sync worker) runs a periodic `SELECT` against the consumer DB and writes a denormalized mirror into `oems_client_c`, `oems_client_holding_c`, `oems_client_strategy_c` etc. in OEMS. OEMS becomes a derived read-model; the consumer is the source of truth.**

| Cost | Risk | Benefit |
|---|---|---|
| **High** — new worker code (a "consumer-mirror" loop), new OEMS tables (`oems_client_c`, `oems_client_holding_c`, `oems_client_strategy_c`, `oems_client_kyc_c`), new Railway service (or a second loop in the existing worker), new Vercel env vars for the consumer-side connection, conflict resolution logic (what happens when the consumer's `wallets.balance` is the user's *reported* balance and the IRESS `oems_account_c.cash_balance` is the *brokerage's* view?), and a synchronisation policy (eventual consistency? how eventual? what is the SLA when the consumer is mid-transaction?) | **High** — a *new* class of bugs ("the mirror is stale by 4 minutes and the operator placed a trade on stale data"); consumer-DB schema evolution is now an OEMS-DB migration concern (if the consumer team renames a column, our mirror breaks); we are *adding* a sync layer where Strategy B does not need one; the consumer's `transactions` ledger and the OEMS's `oems_order_audit` are still not joined in the DB, so the BFF still has to call two places — the only thing we have saved is a cross-DB HTTP hop, and we have paid for it with a sync worker | **Theoretical** — "one query" reads in the OEMS BFF (just `oems_client_c` joins) instead of a BFF hop to the consumer; faster operator UI |

**Verdict: C is worse than B.** It looks elegant on a whiteboard ("single read model, fast queries") but it pushes the real cost into a *synchronisation problem* (which is much harder than a BFF hop), and it does not solve the *only* problem the OEMS actually has (the operator needs to see "client X's name and KYC status next to their IRESS account"). Strategy B solves that with one BFF route. Strategy C solves it with a sync worker, a new schema in OEMS, a new Railway service, and a new SLO. **Reject C.**

---

## 4. Strategy B — implementation plan

### 4.1 Guiding principles

1. **The OEMS is operator-only in v1.** Consumer end-users do **not** sign in to MyMint. They do not see the OEMS UI. They do not have an OEMS-side `auth.users` row. (See open question 1 in §7.)
2. **The OEMS worker is the sole writer of IRESS-grade data into MyMint.** Consumer-app writers (the Lovable-built app) never write to MyMint.
3. **The consumer DB is read-only from the OEMS side, via a BFF route, with the consumer's *service-role key* server-side.** We do *not* hit the consumer's anon key from the OEMS — we hit the consumer's *read replica* via a service-role client. (A `service_role` bypasses RLS, which is fine for an OEMS operator reading their own client's data; we should still log every read for audit.)
4. **The stable join key is `mint_number`.** We define `mint_number` as a text column (e.g. `M-00041`) on both the consumer's `profiles` table (the source) and a new `oems_client_c.mint_number` column in OEMS (the mirror's join key). The OEMS never *creates* a `mint_number` — it reads them from the consumer.
5. **Currency conversion is a *display* concern, not a schema concern.** Consumer `wallets.balance` is Rands; OEMS `oems_account_c.cash_balance` is currency-native (Rands). They are the same unit. Consumer `stock_holdings_c.market_value` is cents; OEMS `oems_position_c.market_value` is Rands. The BFF does the `÷ 100` in TypeScript, not in SQL.
6. **All Supabase migrations remain review-only and user-pasted in the SQL editor.** The worker never auto-applies DDL. This rule still holds.
7. **The `SUPABASE_URL` on Vercel + Railway points at MyMint (`nnwzhxfjpjbzujevwzlh`).** It does **not** change to point at the consumer project. The consumer URL is a *new* env var on Vercel + Railway: `CONSUMER_SUPABASE_URL`.

### 4.2 New tables in OEMS MyMint

> All migrations are review-only. Listed in apply-order.

| Migration | Table | Purpose |
|---|---|---|
| `20260614_oems_client_c.sql` | `oems_client_c` (PK `mint_number text`, columns: `display_name text`, `email text`, `phone text`, `kyc_status text`, `kyc_verified_at timestamptz`, `consumer_last_synced_at timestamptz`, `consumer_payload jsonb`, `created_at`, `updated_at`) | The OEMS-side mirror of "who is this client?" — written by the **consumer-sync worker loop** (see §4.4), *not* by the IRESS worker. RLS: deny anon/auth; service_role only. |
| `20260614_oems_client_account_link_c.sql` | `oems_client_account_link_c` (PK `id uuid`, `mint_number text` FK-style reference, `iress_account_code text`, `link_kind text` CHECK IN ('primary','mirror','historical'), `linked_at timestamptz`, `payload jsonb`) | The *explicit* mapping table between a consumer `mint_number` and one or more IRESS `AccountCode`s. An operator (or a future onboarding flow) creates a row here when they on-board a consumer client to the IRESS desk. Without this row, the OEMS cannot render the consumer's IRESS account. RLS: deny anon/auth. |
| `20260614_oems_client_strategy_link_c.sql` | `oems_client_strategy_link_c` (PK `id uuid`, `mint_number text`, `oems_strategy_id text` FK to `oems_strategy_c.strategy_id`, `allocation_pct numeric`, `linked_at`) | A consumer "I'm on the SA Equity Core strategy" maps to one or more firm `oems_strategy_c` rows with an allocation percent. This is the *cross-reference* between consumer `strategies_c` and OEMS `oems_strategy_c` — the two tables are never merged. |
| `20260614_oems_consumer_read_audit_c.sql` | `oems_consumer_read_audit_c` (PK `id uuid`, `mint_number text`, `route text`, `requested_by_user_id uuid` — the OEMS operator's `auth.uid()`, `requested_at timestamptz`, `response_status text`, `payload jsonb`) | Audit log of every BFF route that reads the consumer DB on behalf of an operator. **Compliance will want this.** The consumer DB is sensitive (KYC, banking); every operator access is logged. |

### 4.3 New env vars

| Var | Where | Value / source | Purpose |
|---|---|---|---|
| `CONSUMER_SUPABASE_URL` | Vercel (server) + Railway (worker, for the consumer-sync loop) | `https://mfxnghmuccevsxwcetej.supabase.co` | The consumer project's URL. **Never `NEXT_PUBLIC_`.** |
| `CONSUMER_SUPABASE_SERVICE_ROLE_KEY` | Vercel (server, for the gateway BFF) + Railway (worker, for the consumer-sync loop) | Service-role key from the consumer project (after rotation per §6) | Server-side read of consumer data. **Never `NEXT_PUBLIC_`.** Rotated alongside the consumer project's service-role key. |
| `CONSUMER_SUPABASE_ANON_KEY` | Vercel (browser) — *only* if the consumer app is re-pointed to read OEMS data via the BFF, which is *not* in v1. | Anon key from the consumer project | Not used in v1; documented for future. |
| `OEMS_OPERATOR_AUTH_USER_IDS` | Vercel (server, in the BFF middleware) | Comma-separated list of MyMint `auth.users.id` UUIDs allowed to access `/oems/*` | The OEMS is operator-only in v1. The middleware checks `auth.uid()` is in this allowlist before serving any `/oems/*` page. (Or use a `profiles` table on MyMint with a `role` column — see open question 2.) |
| `WORKER_HTTP_TOKEN` | Vercel + Railway | (Already exists, per `AGENTS.md`.) | Unchanged. |
| `CONSUMER_SYNC_INTERVAL_SEC` | Railway (worker) | default `300` (5 min) | How often the consumer-sync loop runs. |
| `CONSUMER_SYNC_DRY_RUN` | Railway (worker) | default `1` | Default off; flip to `0` only after the operator reviews the first dry-run diff. |

### 4.4 New BFF routes on Vercel

All under `src/app/api/consumer/`. All `runtime = "nodejs"`. All require an authenticated OEMS operator session (the `mint-auth` cookie today; the Supabase Auth JWT in prod).

| Route | Method | Reads from | Returns |
|---|---|---|---|
| `/api/consumer/[mint_number]` | `GET` | Consumer `profiles` (Rands-respecting) | `{ mint_number, display_name, email, kyc_status, kyc_verified_at, wallet_balance_rands, last_synced_at, source }` |
| `/api/consumer/[mint_number]/holdings` | `GET` | Consumer `stock_holdings_c` | `{ mint_number, holdings: [{ symbol, quantity, market_value_cents, cost_basis_rands }], source }` |
| `/api/consumer/[mint_number]/strategies` | `GET` | Consumer `strategies_c` | `{ mint_number, strategies: [{ strategy_slug, status, allocated_pct }], source }` |
| `/api/consumer/[mint_number]/transactions` | `GET` | Consumer `transactions` (paginated) | `{ mint_number, transactions: [...], page, total, source }` |
| `/api/consumer/[mint_number]/kyc` | `GET` | Consumer KYC tables | `{ mint_number, kyc_status, kyc_verified_at, document_types: [...], source }` |
| `/api/consumer/health` | `GET` | Consumer `auth.users` count (heartbeat) | `{ ok, consumer_reachable, last_consumer_read_at, source }` |

**`source` enum:** `"consumer-db"` when live, `"unavailable"` when the consumer DB is unreachable, `"unconfigured"` when the env vars are not set. The UI surfaces `unavailable` as a "Consumer DB unreachable — operator can still see IRESS account" empty state. **Never** render seed/mock data for consumer-derived fields — same policy as the OEMS quote data.

Every successful read writes one row to `oems_consumer_read_audit_c` (or, if that migration is not yet applied, an in-memory ring buffer in the BFF — the same pattern as the worker's `recent_events`).

### 4.5 New worker code in `workers/iress-ingest`

A new module `workers/iress-ingest/src/consumer-sync.ts`, with a periodic loop (driven by `CONSUMER_SYNC_INTERVAL_SEC`, default 5 min, default `CONSUMER_SYNC_SYNC_DRY_RUN=1`):

```
loop:
  1. SELECT mint_number, display_name, email, phone, kyc_status, kyc_verified_at
     FROM consumer.profiles
     WHERE updated_at > last_cursor
     ORDER BY updated_at ASC
     LIMIT 500
  2. UPSERT into oems_client_c
     ON CONFLICT (mint_number) DO UPDATE
     SET display_name = EXCLUDED.display_name, ...
  3. advance last_cursor
  4. log to integration_worker_health.metadata.recent_events
```

The worker uses the **consumer's** service-role key server-side to read, and the **OEMS's** service-role key server-side to write. **No keys cross the network in plaintext** beyond the env-var delivery. The consumer-sync loop is **idempotent** and **backfillable** (re-running with `last_cursor = '1970-01-01'` rebuilds `oems_client_c` from scratch).

The loop runs in the same worker process as the IRESS ingest (single replica, single ApplicationID, single license seat) — *not* a separate Railway service, because the consumer-sync is a *read* loop, not an IRESS SOAP caller, and we want the heartbeat to be unified. The `integration_worker_health` row gets a new `metadata.consumer_sync` sub-object: `{ last_run_at, last_cursor, last_run_rows, last_run_status }`.

### 4.6 What the operator crosses — auth boundary

| Action | Auth domain crossed | How |
|---|---|---|
| Operator signs in to `/oems` | OEMS MyMint `auth.users` | Supabase Auth (per `AGENTS.md` standing rule) — `mint-auth` cookie is the dev stub; the prod path validates a Supabase Auth JWT. |
| Operator views a client blotter | OEMS auth → reads OEMS data (IRESS) | Standard BFF path: OEMS anon key + RLS, or service-role for the operator-only tables. |
| Operator clicks "show client KYC" | OEMS auth → BFF route → reads consumer DB | OEMS operator's Supabase JWT is verified in the BFF; the BFF uses the *consumer's* service-role key to read the consumer DB; the BFF logs to `oems_consumer_read_audit_c`. |
| Operator views a client holdings breakdown (combines IRESS + consumer holdings) | OEMS auth → two BFF routes | `/api/oems/portfolio` (OEMS) + `/api/consumer/[mint_number]/holdings` (consumer); the page does an in-memory merge. |
| Consumer end-user signs in to the **consumer** app | Consumer `auth.users` | Unchanged. They never see the OEMS. |

### 4.7 Unit / currency alignment

| Field | Side | Unit | OEMS side | Treatment |
|---|---|---|---|---|
| `wallets.balance` | Consumer | Rands | (not in OEMS) | The BFF returns it as `wallet_balance_rands` — ZAR. |
| `oems_account_c.cash_balance` | OEMS | Rands (currency-native) | Yes | Returned as `iress_cash_balance_rands`. |
| `stock_holdings_c.market_value` | Consumer | **cents** | (not in OEMS) | The BFF divides by 100 and returns `holdings[i].market_value_rands` = `(market_value / 100)`. |
| `oems_position_c.market_value` | OEMS | Rands (currency-native) | Yes | Returned as `iress_position_market_value_rands`. |
| `oems_position_c.open_average_price` | OEMS | Rands (currency-native) | Yes | Returned as `iress_open_average_price_rands`. |
| `oems_strategy_c.aum_cents` | OEMS | **cents** | Yes | BFF returns `aum_rands` = `(aum_cents / 100)`. |
| `oems_strategy_c.pnl_today_cents` / `pnl_mtd_cents` | OEMS | **cents** | Yes | BFF returns `pnl_today_rands`, `pnl_mtd_rands`. |
| `oems_order_audit.price_cents` | OEMS | **cents** | Yes | BFF returns `price_rands` = `(price_cents / 100)`. |
| `bonds_c.dv01_cents` | OEMS | **cents** | Yes | BFF returns `dv01_rands` = `(dv01_cents / 100)`. |
| `money_market_instrument_c.notional_cents` | OEMS | **cents** | Yes | BFF returns `notional_rands` = `(notional_cents / 100)`. |

**The two unit systems are *not* in conflict at the database level** — they are in different schemas, and the BFF normalises to Rands at the API boundary. **This is a `÷ 100` in TypeScript, not a schema merge.**

### 4.8 Mapping rules

| Consumer concept | OEMS concept | How we join |
|---|---|---|
| `profiles.id` (uuid) | (n/a — OEMS has its own `auth.users`) | We never join on `id`. We join on `mint_number` (a text column, e.g. `M-00041`) that the consumer team adds to `profiles` and we mirror to `oems_client_c.mint_number`. |
| `profiles.email` | (n/a) | We display it in the OEMS blotter header; we do not write it to OEMS. |
| `wallets.balance` (Rands) | `oems_account_c.cash_balance` (Rands) | We render both side by side. They are not summed. |
| `stock_holdings_c.symbol` | `oems_position_c.security_code` | We display both side by side. The OEMS's is the trading-desk source of truth. |
| `strategies_c.strategy_slug` (consumer UX) | `oems_strategy_c.strategy_id` (firm mandate) | One-to-many via `oems_client_strategy_link_c`. |
| `transactions` (consumer ledger) | `oems_order_audit` (IRESS audit) + `oems_transaction_c` (IPS history) | Reconciled at the *operator view*, not joined in SQL. |
| KYC tables | (n/a) | Read via BFF, displayed but not mirrored. |
| Banking-link tables | (n/a) | Read via BFF, displayed but not mirrored. |
| Gift-claim tables | (n/a) | Not in the OEMS scope. |

### 4.9 Migration order (apply to MyMint `nnwzhxfjpjbzujevwzlh` after the existing 14)

In this order. Each is review-only and user-pasted.

1. **`20260614_oems_client_c.sql`** — `oems_client_c` table. *Pre-requisite for the others.*
2. **`20260614_oems_client_account_link_c.sql`** — `oems_client_account_link_c` table. *Pre-requisite for the cross-reference feature.*
3. **`20260614_oems_client_strategy_link_c.sql`** — `oems_client_strategy_link_c` table. *Pre-requisite for the cross-reference feature.*
4. **`20260614_oems_consumer_read_audit_c.sql`** — `oems_consumer_read_audit_c` table. *Pre-requisite for compliance audit.*
5. **The 4 *pending* migrations** that were already drafted (`20260613000001..00004_oems_*`) — these are independent of the new ones and can be applied in any order, but apply them *before* the BFF routes ship so the BFF does not 503 on missing tables.

**Cutover plan:**

- **Phase 0 (now):** The 4 pending OEMS migrations + the 4 new `oems_client_*` migrations are pasted in the MyMint SQL editor by the user. No consumer-app change. No operator-visible change.
- **Phase 1 (after the OEMS is live, the worker is on `IRESS_MODE=live` with writes enabled, and the operator is using the desk):** A new consumer-sync worker loop is enabled with `CONSUMER_SYNC_DRY_RUN=1`. It runs for 48–72 hours, populating `oems_client_c` from `consumer.profiles`. The operator reviews the diff. Flip to `0`.
- **Phase 2 (week 1 after Phase 1):** The BFF gateway routes ship behind a `consumer_db_enabled` flag (off by default). The OEMS blotter shows a "View consumer KYC" button that calls `/api/consumer/[mint_number]/kyc` — visible only if the row exists in `oems_client_account_link_c`.
- **Phase 3 (week 2+):** The operator UI starts cross-referencing the two sides. The "client overview" page renders the wallet + IRESS account + holdings side by side. Audit logging is in place from Phase 1.
- **No Phase 4 (yet):** Consumer-app migration to MyMint is deferred indefinitely. Re-evaluate after 6 months of production.

### 4.10 v1 vs what must wait

| What ships in v1 (next 2–4 weeks) | What waits |
|---|---|
| The 4 pending OEMS migrations | Consumer-app re-platform onto MyMint (deferred) |
| The 4 new `oems_client_*` migrations | Real-time CDC between consumer and OEMS (eventual consistency is fine) |
| The `consumer-sync` worker loop (dry-run → live) | Two-way writes between consumer and OEMS (we only ever *read* consumer) |
| The `/api/consumer/*` BFF routes | Consumer-app users signing in to the OEMS (operator-only in v1) |
| Audit logging (`oems_consumer_read_audit_c`) | RLS rewrite on the consumer side (we use the service-role key server-side, with audit) |
| Operator cross-reference UI on the OEMS blotter | Cross-DB SQL views (impossible across Supabase projects anyway) |

---

## 5. Migration window — what we do *right now*

In the order below, the user should:

1. **Rotate the consumer project's service-role key + anon key.** See §6.
2. **Paste the 4 pending OEMS migrations** into MyMint's SQL editor (`20260613000001..00004_oems_*`). These are already drafted.
3. **Paste the 4 new `oems_client_*` migrations** (per §4.2) into MyMint's SQL editor.
4. **Add the env vars** to Vercel + Railway per §4.3 (`CONSUMER_SUPABASE_URL`, `CONSUMER_SUPABASE_SERVICE_ROLE_KEY`, `CONSUMER_SYNC_INTERVAL_SEC`, `CONSUMER_SYNC_DRY_RUN=1`).
5. **Add `mint_number` as a column to the consumer's `profiles` table** (one-time SQL: `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mint_number text UNIQUE; UPDATE profiles SET mint_number = 'M-' || lpad(row_number() OVER (ORDER BY created_at)::text, 5, '0') WHERE mint_number IS NULL;`). This is a *consumer-DB* change, not a MyMint change. The user's Lovable-era app keeps working.
6. **Add a backfill**: the consumer team populates `mint_number` for every existing row in `profiles`. One-time.
7. **Wire the consumer-sync loop in the worker** (new `workers/iress-ingest/src/consumer-sync.ts`).
8. **Ship the BFF routes** (`/api/consumer/[mint_number]/*`) behind the `consumer_db_enabled` flag.
9. **Add the operator-allowlist middleware** on `/oems/*` (or replace `mint-auth` with Supabase Auth + a `role` check, per `AGENTS.md`'s standing rule).
10. **Audit-log every consumer read** to `oems_consumer_read_audit_c`.

---

## 6. ⚠️ SECURITY INCIDENT — service-role key + anon key pasted in chat

The user pasted **two JWTs from the consumer project** (`mfxnghmuccevsxwcetej`) into the chat message that triggered this strategy memo:

- **Service-role key** (CRITICAL — bypasses RLS, full DB read/write):
  ```
  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1meG5naG11Y2NldnN4d2NldGVqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODg1MjU4MCwiZXhwIjoyMDg0NDI4NTgwfQ.0gsEFLa3PtZ82Oams9qbbdx6MFHCMCSlL-aa_ZcHHsY
  ```
  This key has `role: "service_role"`, which means **anyone who has this string can read every row, write to every table, bypass every RLS policy, and impersonate any user** on the consumer project — for the lifetime of the JWT, until `exp` (timestamp `2084428580` = 2036-04-08, ~10 years). The user **must rotate this immediately**.

- **Anon key** (still sensitive — designed for browser use, but should not be in chat):
  ```
  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1meG5naG11Y2NldnN4d2NldGVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NTI1ODAsImV4cCI6MjA4NDQyODU4MH0.lktfglzBMaHd79hLFDRH1HHSwsEwZ56Tv6e287kQiFg
  ```
  The anon key is "less critical" only in the sense that the *intended* design is for it to be public (it is shipped in the Lovable-built consumer app's JS bundle). But pasting it in a chat is still a leak — it lets a sophisticated attacker fingerprint the project, correlate the project with the user's other infrastructure, and plan a targeted attack. **Rotate it as a precaution, then update the consumer app's `NEXT_PUBLIC_SUPABASE_ANON_KEY` env var** (which is a redeploy, not a database change).

> **Both keys are also referenced in `AGENTS.md` under "Never put IRESS passwords or API keys in `AGENTS.md`, client bundles, or `NEXT_PUBLIC_*` variables"** — the same rule applies to Supabase keys. Pasting them in chat is a leak, not a publishable reference. The user must scrub them from chat history if their chat platform allows it.

### 6.1 Steps to rotate the consumer project keys

1. **Open the Supabase dashboard** for `mfxnghmuccevsxwcetej.supabase.co`. Sign in as the project owner.
2. **Go to Settings → API** (`https://supabase.com/dashboard/project/mfxnghmuccevsxwcetej/settings/api`).
3. **Click "Generate new" under "Project API keys".** This issues a new service-role key and a new anon key. The old keys are **revoked immediately** when the new ones are issued.
4. **Copy the new service-role key and new anon key** to your password manager. Do not paste them in chat.
5. **Update the consumer app's environment** with the new anon key. This is a redeploy of the Lovable-built app, not a database change. The anon key is shipped in the JS bundle; rotation is non-disruptive (the app keeps using it until the next deploy).
6. **Update any server-side integrations** (cron jobs, edge functions, scripts) that hold the *old* service-role key with the new one. For Mint's case, this is the *only* server-side integration: the consumer app itself (which should not have the service-role key — only the anon key in the browser). If a service-role key has been deployed in a server env var (e.g. in Vercel or Railway), update that env var to the new value.
7. **After rotation, the old JWTs in this chat are inert.** They will not work; the Supabase JWT verifier will reject them.

### 6.2 What to check in Supabase logs for misuse

The dashboard exposes the API logs at `https://supabase.com/dashboard/project/mfxnghmuccevsxwcetej/logs/api-logs`. Between the time the keys were pasted in chat and the time you rotated them, look for:

- **Unusual `service_role`-authenticated requests** (the `role` claim in the JWT identifies the actor — service-role is the dangerous one). Any request authenticated with the *old* service-role key is a leak.
- **Requests from unfamiliar IPs** that are not your normal Vercel / Railway / local-dev ranges. The dashboard shows the source IP for each request.
- **Reads from `profiles`, KYC tables, banking-link tables** that are not from the consumer app's normal traffic. The dashboard groups by route, and the consumer app's normal reads come from a small set of routes — anything else is suspicious.
- **Writes to `profiles` or `wallets`** that you did not initiate. A service-role write bypasses RLS and can mutate any row.
- **Reads from `auth.users`** — the service-role key can read every user record. There is no legitimate reason for an external caller to do this.

If you find any of the above, escalate to the Supabase support team and consider a full auth-session reset for the consumer project (sign out every user, force MFA re-enrolment).

### 6.3 Forward rule (add to `AGENTS.md`)

The same rule that already says "Never put IRESS passwords or API keys in `AGENTS.md`, client bundles, or `NEXT_PUBLIC_*` variables" should be extended to **Supabase service-role keys** and **any other production secret**. The standing rule is: **paste JWTs in chat = leak = rotate.** If a user needs to share a JWT for debugging, they should (i) use a Supabase read-only scoped key, (ii) scope it to a single table and a short TTL, and (iii) rotate it after the debug session.

---

## 7. Open questions for the user (decision-needed before §4.5 ships)

These are the 5–7 most important things the user needs to decide before we start the merge work. None of them block the OEMS go-live (which proceeds on the existing schedule per `AGENTS.md`'s "step 1: Railway Iress-Worker connected to IRESS with endpoints verified before dashboard/UI work" rule). They block *the consumer cross-reference feature*.

1. **Is the OEMS supposed to be admin/operator-only, or are end-clients going to log in to it too?** This is the single biggest decision. If end-clients log in to the OEMS, the auth-domain split is much harder (we need cross-project JWT verification, which is a non-trivial feature). If the OEMS is operator-only, the consumer end-user never has an OEMS identity and the auth-domain split is irrelevant. **Default: operator-only in v1.** Confirm.

2. **Operator allowlist — what is the source of truth?** We have two options: (a) hard-coded list of `auth.users.id` UUIDs in an env var (`OEMS_OPERATOR_AUTH_USER_IDS`); (b) a `profiles` table on MyMint with a `role` column (`role IN ('operator','compliance','admin')`) and an RLS policy that checks `auth.uid() IN (SELECT id FROM profiles WHERE role IN ('operator','compliance','admin'))`. (a) is faster; (b) is more auditable. **Default: (b) with a follow-up migration `20260614_oems_operator_profiles_c.sql`.** Confirm.

3. **What is the `mint_number` strategy?** The simplest is a text column on the consumer's `profiles` table, populated by a one-time `ALTER TABLE` + `UPDATE`. The alternative is to use the consumer's `auth.users.id` UUID as the join key. (a) is more human-readable for the operator UI; (b) is more "no schema change on the consumer side" friendly. **Default: (a) — add `mint_number text UNIQUE` to the consumer's `profiles` table.** Confirm.

4. **What is the audit-trail SLA?** Every BFF route that reads the consumer DB writes to `oems_consumer_read_audit_c`. The question is retention: 30 days, 90 days, 7 years (financial-services default). **Default: 7 years** (this is a financial-services product, the consumer's KYC and transactions are FAIS-relevant). Confirm.

5. **What happens when the consumer DB is offline?** The BFF can either (a) fail the entire OEMS request with a 503 ("consumer DB unreachable"), or (b) degrade gracefully — render the OEMS blotter without the consumer-derived fields, with a "Client details temporarily unavailable" placeholder. **Default: (b)** — the OEMS operator can still see IRESS accounts and positions even if the consumer DB is down. Confirm.

6. **Who can edit the `oems_client_account_link_c` table?** Is it the operator (a `/api/oems/clients/[mint_number]/link` form), or is it a back-office batch (a SQL migration that the user pastes)? **Default: operator, via a BFF route, with audit.** Confirm.

7. **What is the consumer-team's view of this strategy?** They own the consumer app; they may have opinions about adding `mint_number` to `profiles`, or about the OEMS reading the consumer's KYC, or about the consumer-app's *future* retirement onto MyMint. **Default: share this doc with them and ask.** The user's standing rule ("IRESS follow-up emails to Charles should be reply-toned on the existing thread, not cold first-contact") suggests the same approach for the consumer team: don't surprise them, copy them on the decision.

---

## 8. Reference: standing rules from `AGENTS.md` that this strategy respects

- **"Never put IRESS passwords or API keys in `AGENTS.md`, client bundles, or `NEXT_PUBLIC_*` variables"** — extended to Supabase service-role keys. The §6 incident is the trigger for the extension.
- **"Replace dev `admin`/`admin` app login with Supabase Authentication for production users"** — Strategy B uses Supabase Auth on MyMint for the OEMS operators. The consumer app already has its own Supabase Auth on the consumer project; we do not touch it.
- **"`/oems` is the main entry after login, not a marketing landing page"** — unchanged. The OEMS login is OEMS-side, on MyMint.
- **"All Supabase migrations are review-only and user-pasted in SQL editor"** — every migration in §4.2 and §4.5 is review-only and user-pasted. The worker never auto-applies DDL.
- **"Railway and Vercel `SUPABASE_URL` must both point at MyMint — not `mfxnghmuccevsxwcetej`"** — Strategy B adds a *second* Supabase URL (`CONSUMER_SUPABASE_URL`) for the BFF gateway. The *primary* `SUPABASE_URL` still points at MyMint. The new var is named distinctly to avoid the misconfiguration the rule is designed to prevent.
- **"Wants explicit opt-in for LIVE writes (worker defaults `IRESS_WORKER_DRY_RUN=1` and `SUPABASE_ALLOW_WRITES=0`)"** — the consumer-sync loop defaults to `CONSUMER_SYNC_DRY_RUN=1` per §4.3. The operator flips it to `0` only after reviewing the dry-run diff.
- **"Clear LIVE/MOCK/SEED/SUPABASE/STREAM/UNCONFIGURED/WORKER labels and no fake/seed data on production pages"** — every new BFF route's `source` field is one of `consumer-db`, `unavailable`, `unconfigured`. The UI surfaces `unavailable` as an honest empty state, never a seed fallback.
- **"Dispatches multi-agent workers for larger implementation batches"** — the work in §4.4 (new worker module) and §4.5 (new BFF routes) is a reasonable candidate for a multi-agent batch when we are ready to ship it. The strategy and the migrations are deliberately decoupled from the worker code so the migrations can be pasted first.

---

## 9. What we'd lose / what we'd gain — quick table

| Option | Lose | Gain |
|---|---|---|
| **A. Merge** | A working consumer app's uptime guarantee during the cutover; weeks of compliance review on a financial-services data migration; the option to back out (merging is hard to reverse); the ability to ship the OEMS in the next 2 weeks | A single Supabase project; one auth domain; one mental model; one set of RLS |
| **B. Keep separate (recommended)** | The "single source of truth" ideal; a single set of RLS to audit; the ability to do a SQL JOIN across consumer and OEMS (we will not need to — the join is at the operator view, in TypeScript) | Zero risk to the consumer app; OEMS ships on schedule; the auth-domain split is a feature (a compromise of one project does not leak the other); we can deprecate the consumer project *later* with no rush; the implementation is ~3 days of engineering |
| **C. Hybrid mirror** | The simplicity of "read consumer when you need it" (Strategy B); the option to back out (a sync worker is harder to remove than a BFF route); the OEMS team's ability to ship the OEMS in the next 2 weeks (the sync worker is on the critical path) | Faster OEMS reads (no cross-DB HTTP hop) at the cost of a sync layer; the "single read model" whiteboard diagram |

---

*Last updated: 2026-06-13. Re-review after the user answers the §7 open questions and after the §6 key rotation.*
