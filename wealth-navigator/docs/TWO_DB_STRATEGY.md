# Two-Database Strategy — Mint Consumer (Eververse) vs. MyMint OEMS

> **⚠️ SUPERSEDED (2026-06-13) by [`DB_TOPOLOGY_DECISION.md`](DB_TOPOLOGY_DECISION.md)** — final decision is a 3-DB topology (retail prod `mfxng…` / institutional prod `nnwz…` promoted from test / fresh staging), driven by a compliance separation requirement. Background only below.
> **Audience:** Mint / MyMint product + engineering leads.
> **Scope:** Strategic recommendation for the relationship between the **Mint consumer app** Supabase project (ref `mfxnghmuccevsxwcetej`, "Eververse") and the **MyMint OEMS** Supabase project (ref `nnwzhxfjpjbzujevwzlh`, "MyMint").
> **Decision required this week.** See §10 for the 3-paragraph executive summary.

---

## 1. TL;DR

| Q | A |
|---|---|
| Merge or stay separate? | **Keep separate.** The two apps serve different users, different compliance regimes, and have already diverged in schema. |
| How do they share reference data? | **Either (a) the OEMS writes its own copy, OR (b) a thin read-only `securities_c` + `stock_intraday_c` cross-project publication** — but in practice **(a) is correct: the OEMS already does this.** |
| Is there a consumer table the OEMS actually needs? | **Yes — the consumer `securities_c` catalogue may be the JSE watchlist the OEMS is supposed to track.** This is the only meaningful shared data. See §3. |
| Can a single user log into both apps? | **No — Supabase Auth is per-project, and a user gets a different UUID in each project.** That is fine: a person in the OEMS is a *trader representative*, a person in the consumer app is a *retail investor*. They are not the same legal person. |
| What needs to happen this week? | (1) Make the decision in writing, (2) confirm the OEMS's `securities_c` is the canonical master going forward, (3) freeze consumer-DB writes from any OEMS code path. See §10. |

---

## 2. The three options

### Option A — Merge into one Supabase project
Two apps share one DB. RLS partitions the data by `app_namespace = 'consumer' | 'oems'`.

| Pros | Cons |
|------|------|
| One user table, one login, one RLS regime to audit | A single bug in OEMS RLS could expose consumer KYC / wallet data, and vice-versa |
| Cross-app joins become trivial (a retail user could see their own institutional mandate) | FAIS / JSE trader rules require separation of *books and records* between retail and institutional lines |
| One Supabase Auth, one set of keys, one backup | `securities_c` already diverges (consumer = retail, OEMS = IRESS-instrumented with RIC/ISIN/sector refdata). One of them wins; the other migrates. |
| Cheaper to operate | The two projects have **independent RLS policies already** — the consumer RLS assumes `auth.uid() = profiles.id` retail semantics; the OEMS RLS assumes service_role writes + trader-only reads. Reconciling them is a multi-week project. |

**Verdict:** rejected — the compliance surface (FSCA + JSE rules) expects *books and records* to be partitionable, and forcing that into a single project's RLS layer creates a single point of failure for both apps.

### Option B — Keep separate (recommended)
Two independent Supabase projects, **no cross-writes in v1**. Each app owns its own `profiles`, its own `securities_c`, its own RLS, its own compliance audit trail.

| Pros | Cons |
|------|------|
| Clean separation of regulated vs. institutional data; auditor-friendly | A retail user who later wants to view their institutional portfolio has to log into the OEMS separately |
| Each app's RLS stays narrow; no cross-app leak risk | `securities_c` exists in both projects — potential drift in instrument metadata |
| OEMS and consumer can be sold/licensed independently to different counterparties | Two Supabase bills, two backup stories, two on-call rotations |
| Schema evolves independently — consumer can ship wallet/credit changes without touching OEMS RLS | A small amount of glue if a shared "watchlist" feature is ever wanted |

**Verdict:** this is the **ship-it** path. It matches what the user has already done (OEMS built against a clean project, consumer is already in production), and it does not require freezing either app's roadmap.

### Option C — Keep separate with a read-replica of `securities_c` + `stock_intraday_c`
Like (B), but the OEMS pulls a read-only feed of consumer reference data via a Postgres publication or a worker.

| Pros | Cons |
|------|------|
| Single source of truth for instrument metadata | A real-time replica adds a moving part (publication, replication slot, conflict resolution) |
| OEMS sees the same ticker list the consumer app shows retail users | The OEMS already has its own richer `securities_c` (RIC, ISIN, sector refdata — `20260612000004_iress_instrument_enrichment.sql`); a feed from the consumer would *downgrade* it |
| Useful if retail users ever get a "trade this on the institutional side" cross-link | The consumer's `securities_c` is built for retail UI (price-only); the OEMS needs IRESS-grade refdata. The OEMS is the better source, not the consumer. |

**Verdict:** rejected — the OEMS `securities_c` is already strictly more capable than the consumer's. The OEMS would be the source of truth, not the consumer. A publication the other way is unnecessary.

### The one-sentence decision
**Ship Option B (keep separate). The OEMS's `securities_c` is already the cleaner, more recent, IRESS-instrumented catalogue, so the OEMS writes its own reference data and ignores the consumer DB. If a retail user is ever added to the OEMS, that is a v2 problem with a federation pattern, not a v1 schema merge.**

---

## 3. Critical cross-project data: does the OEMS need the consumer DB?

This is the most important question in the document, and the answer is **almost entirely no, with one exception to verify.**

| Consumer table the OEMS might need | Verdict |
|-------------------------------------|---------|
| `securities_c` (consumer's instrument list) | **OEMS already has its own, richer version** (`20260612000004_iress_instrument_enrichment.sql` adds RIC, ISIN, sector refdata). The OEMS worker writes to OEMS `securities_c` from IRESS. The consumer's is a *subset* (probably JSE-listed retail-facing only). No read needed. |
| `stock_intraday_c` (consumer's live prices) | **OEMS writes its own** from the IRESS worker; the OEMS `stock_intraday_c` is populated by `PricingQuoteGet` upserts. The two are independent snapshots. No read needed. |
| `stock_returns_c` (consumer's EOD) | **OEMS already has its own** (EOD closes from `stock_intraday_c` aggregation). No read needed. |
| `profiles` (consumer's KYC'd retail users) | **No.** The OEMS operators are trader representatives, not retail customers. They are vetted via FAIS representative status, not Sumsub. The OEMS's own `profiles` is correct. |
| `transactions` (consumer's wallet money movement) | **No.** The OEMS is *upstream* of order routing, not downstream of consumer settlement. A consumer's R5 000 deposit has nothing to do with a JSE working pad. |
| `wallets`, `gift_claims`, `credit_accounts`, `insurance_policies`, `loan_application` | **No.** Pure consumer products. No OEMS read. |
| `strategies_c` (consumer's retail strategy catalogue, JSON holdings) | **No.** The OEMS has `oems_strategy_c` (mandate-level rollup with `aum_cents` / `pnl_today_cents` / `investor_count`). The consumer's is a *productised* version for retail; the OEMS's is an *institutional* rollup. Different concept entirely. |
| `user_strategies` (consumer's link table: user → strategy) | **No.** Same reason. |
| `stock_holdings_c` (consumer's per-user position) | **No.** The OEMS has `oems_position_c` (IPS mirror, per-account) for institutional. Consumer's is per-user; OEMS's is per-account. Different join keys. |
| `client_strategy_returns_c` (consumer's per-user P&L) | **No.** The OEMS does not need to surface retail P&L. |
| `investment_goals` (consumer's goal-based investing) | **No in v1.** Could be modelled as "institutional mandate objectives" later, but v1 is silent on this. |
| `family_members` | **No.** |
| `order_emails`, `notifications`, `mint_mornings_log` | **No.** |
| `news_articles` | **OEMS has its own** (`news_item_c`, vendor-fed in `20260613000004_oems_instrument_universe.sql`). No cross-read. |
| `user_sessions`, `it_incidents` | **No.** Per-app concern. |
| `user_onboarding`, `user_onboarding_pack_details`, `required_actions` | **No.** Consumer KYC flow only. |
| `truid_bank_snapshots`, `loan_engine_score`, `credit_transactions_history` | **No.** Consumer banking only. |
| `subscriptions` | **No.** Consumer billing only. |
| `family_members` | **No.** |
| Storage buckets `signed-agreements`, `sumsub-archive` | **No.** Consumer KYC artefacts only. |

### The one table to double-check: `securities_c`

The consumer's `securities_c` is described as a "master catalogue, cents" and is most likely the **JSE retail watchlist the consumer app uses to display share prices to retail users.** If that watchlist is curated by the Mint product team (e.g. the 80 most-traded JSE names), the OEMS might be expected to track the *same* list — meaning both projects' `securities_c` should converge on a single symbol universe.

**Action:** diff the two `securities_c` schemas (R code / ISIN / sector columns) and the row sets once the consumer-DB is readable from the MyMint team. If the consumer's list is a *superset* of the OEMS's, the OEMS may want to add the missing tickers to its own `securities_c` and have the worker upsert them. **No data sharing is needed — the OEMS worker just needs to be told the symbol list.**

> This is the *only* table where a cross-project check is required, and the answer is almost certainly "the OEMS's `securities_c` is the canonical source; the consumer reads from there if it ever needs IRESS-grade refdata."

---

## 4. Table-by-table mapping

Classifications: **SAME** = same concept, can be merged; **OVERLAP** = same domain, different schema, unifiable; **CONSUMER-ONLY** = no OEMS equivalent; **OEMS-ONLY** = no consumer equivalent; **REFERENCE-DATA-SHARED** = read-only shared.

| Consumer table | OEMS table | Classification | Notes / Proposed unified schema |
|----------------|-----------|----------------|---------------------------------|
| `profiles` | `profiles` (created in initial OEMS migration) | **OVERLAP** | Both have email + name + role; consumer adds FICA fields, OEMS adds trader-rep fields. **Unified:** keep MyMint's narrower shape; consumer fields stay in consumer-DB. **No merge.** |
| `user_onboarding` | — | **CONSUMER-ONLY** | Retail onboarding state. No OEMS concept. |
| `user_onboarding_pack_details` | — | **CONSUMER-ONLY** | Same. |
| `required_actions` | — | **CONSUMER-ONLY** | FICA / KYC follow-ups. No OEMS concept. |
| `wallets` | — | **CONSUMER-ONLY** | Rands (not cents — note the unit drift from `transactions`). OEMS never holds client cash. |
| `transactions` | — | **CONSUMER-ONLY** | Cents, has `store_reference`, `settlement_status`. OEMS has no concept of consumer money movement. The cents vs Rands unit difference between `wallets` and `transactions` is a known consumer-app issue. |
| `securities_c` | `securities_c` (IRESS-fed, with RIC/ISIN/sector) | **REFERENCE-DATA-SHARED** | OEMS is the source of truth (richer schema, IRESS-fed). Consumer's is a retail subset. **No sync in v1;** if needed, the consumer reads from OEMS via a future publication. See §3. |
| `strategies_c` (retail) | `oems_strategy_c` (institutional) | **OVERLAP → keep separate** | Different concept: consumer's is a *productised* retail strategy with JSON holdings; OEMS's is an *institutional rollup* with `aum_cents` / `pnl_today_cents` / `investor_count`. **Unification would lose information** in both directions. Keep separate. |
| `user_strategies` | — | **CONSUMER-ONLY** | Per-user link. No OEMS equivalent. |
| `stock_holdings_c` (per-user, qty + avg_fill + market_value cents) | `oems_position_c` (per-account, IPS mirror) | **OVERLAP → keep separate** | Different join keys (`user_id` vs `account_code`), different semantics (user portfolio vs IPS account position). Keep separate. |
| `stock_returns_c` (EOD) | `stock_returns_c` (EOD) | **SAME concept, drift in column shape** | Both hold EOD close / return. **Unified if merge:** keep MyMint's `cents_*` column naming. **In separate mode:** both write EOD from their own worker; no sync. |
| `stock_intraday_c` | `stock_intraday_c` (IRESS-fed, cents) | **REFERENCE-DATA-SHARED** | Both hold intraday ticks. OEMS writes from IRESS worker; consumer's is independent. **No sync in v1;** future Supabase Realtime publication OEMS→consumer if a single source of truth is needed. |
| `strategies_returns_c` | — (computed from `oems_strategy_c.pnl_*_cents`) | **OVERLAP → keep separate** | Consumer's is per-strategy EOD; OEMS's is per-strategy day/mtd P&L. Different cadence and shape. |
| `strategy_metrics` | — | **CONSUMER-ONLY** | Retail strategy KPIs. |
| `client_strategy_returns_c` | — | **CONSUMER-ONLY** | Per-user P&L; not surfaced in OEMS. |
| `strategy_rebalance_residuals` | — | **CONSUMER-ONLY** | Retail rebalance drift. OEMS rebalance is in `oems_position_c` snapshots. |
| `subscriptions` | — | **CONSUMER-ONLY** | Consumer billing. |
| `family_members` | — | **CONSUMER-ONLY** | Family-account concept. |
| `investment_goals` | — | **CONSUMER-ONLY (v1)** | Could map to institutional mandate objectives in v2; v1: separate. |
| `gift_claims` (claim token, expiry 4h) | — | **CONSUMER-ONLY** | Gifting flow. No OEMS concept. |
| `order_emails` | — | **CONSUMER-ONLY** | Retail order confirmations. OEMS blotter notifications are different. |
| `notifications` | — | **CONSUMER-ONLY** | Retail push notifications. |
| `news_articles` | `news_item_c` (vendor-fed) | **OVERLAP → keep separate** | Consumer's is a retail-curated news surface; OEMS's is a vendor-wire feed (SENS / Reuters / Bloomberg). Different taxonomy. |
| `mint_mornings_log` | — | **CONSUMER-ONLY** | Daily morning-summary send log. |
| `truid_bank_snapshots` | — | **CONSUMER-ONLY** | TruID bank verification. |
| `loan_application` | — | **CONSUMER-ONLY** | Consumer credit. |
| `loan_engine_score` | — | **CONSUMER-ONLY** | Consumer credit scoring. |
| `credit_transactions_history` | — | **CONSUMER-ONLY** | Consumer credit. |
| `credit_accounts` | — | **CONSUMER-ONLY** | Consumer credit. |
| `insurance_policies` | — | **CONSUMER-ONLY** | Insurance product. |
| `user_sessions` | — | **CONSUMER-ONLY** | Consumer session tracking (not IRESS-related). |
| `it_incidents` | — | **CONSUMER-ONLY** | IT/ops incident log. |
| `oems_order_audit` (OEMS) | — (no consumer equivalent) | **OEMS-ONLY** | Worker-mirrored IRESS orders. |
| `oems_account_c` (OEMS) | — | **OEMS-ONLY** | IPS account mirror. |
| `oems_position_c` (OEMS) | — | **OEMS-ONLY** | IPS position mirror. |
| `oems_transaction_c` (OEMS) | — | **OEMS-ONLY** | IPS transaction history. |
| `oems_strategy_c` (OEMS) | — | **OEMS-ONLY** | Mandate-level institutional strategy rollup. |
| `oems_curve_metric_c` (OEMS) | — | **OEMS-ONLY** | PCA / carry / rolldown / OIS-spread. |
| `bonds_c` (OEMS) | — | **OEMS-ONLY** | ZAR fixed-income universe. |
| `jibar_fixing_c` (OEMS) | — | **OEMS-ONLY** | SARB daily fixings. |
| `money_market_instrument_c` (OEMS) | — | **OEMS-ONLY** | NCD / TB / FRN. |
| `macro_indicator_c` (OEMS) | — | **OEMS-ONLY** | SARB / StatsSA series. |
| `macro_release_c` (OEMS) | — | **OEMS-ONLY** | Economic-release calendar. |
| `news_item_c` (OEMS) | — | **OEMS-ONLY** | Wire / SENS / regulatory. |
| `index_intraday_c` (OEMS) | — | **OEMS-ONLY** | J203 / J200 sector intraday. |
| `sector_intraday_c` (OEMS) | — | **OEMS-ONLY** | Sector index intraday. |
| `yield_curve_history_c` (OEMS) | — | **OEMS-ONLY** | ZAR NSS / govi fitted curves. |
| `integration_worker_health` (OEMS) | — | **OEMS-ONLY** | Worker heartbeat. |
| `worker_session_metadata` (OEMS) | — | **OEMS-ONLY** | Sticky IRESS ApplicationID. |
| `worker_recent_events` (OEMS) | — | **OEMS-ONLY** | Worker event log. |
| Storage `signed-agreements` (consumer) | — | **CONSUMER-ONLY** | KYC artefacts. |
| Storage `sumsub-archive` (consumer) | — | **CONSUMER-ONLY** | KYC artefacts. |

### OVERLAP unification proposals (for the record, in case of a future merge)

**`profiles` (if ever merged):**
| Column | Consumer | OEMS | Unified |
|--------|----------|------|---------|
| `id` (uuid) | `auth.users.id` | `auth.users.id` | keep `auth.users.id` |
| `email` | text | text | text |
| `full_name` | text | text | text |
| `role` | `retail_user` \| `retail_admin` | `oems_trader` \| `oems_admin` \| `oems_viewer` | single `role` enum + an `app_memberships` join table |
| `fica_status` | `pending` \| `verified` \| ... | — | consumer-only, kept in consumer columns |
| `fais_rep_number` | — | text | OEMS-only, kept in OEMS columns |
| `created_at` | timestamptz | timestamptz | timestamptz |

The cleanest pattern is **two profiles in two projects** — the unified row would have too many nulls and too many role-taxonomy differences to be worth the merge.

**`stock_intraday_c` / `securities_c` (if ever shared):**
Both are already the same shape in both projects (cents, `supabase_realtime`-friendly). The OEMS's version is strictly more capable (RIC, ISIN, sector refdata from `20260612000004_iress_instrument_enrichment.sql`). The merge would simply be "use the OEMS schema." **If a cross-project share is ever needed, use a Supabase publication (Postgres `PUBLICATION`/`SUBSCRIPTION`) from MyMint → consumer.** See §5.

---

## 5. Reference-data sync mechanism (for v2+ if ever needed)

Since Option B (recommended) does not need this in v1, the sync mechanism is documented for completeness:

| Option | Pros | Cons | When to use |
|--------|------|------|-------------|
| **Postgres publication** (MyMint publisher → consumer subscriber) | Native, push-based, near-realtime, free | Adds a replication slot; consumer DB must accept a `SUBSCRIPTION` connection; bidirectional writes need careful conflict resolution | When both projects need to see the same `securities_c` rows in real time |
| **Edge Function cron** (consumer reads OEMS `securities_c` every N min, upserts) | Simple, no replication slot, easy to debug | Lag (poll interval), extra function, write conflicts on duplicate keys | When the consumer just needs a daily refresh of the JSE watchlist |
| **Worker read-through** (OEMS IRESS worker writes to both projects) | One writer, explicit, no replication | Worker becomes a multi-project writer; cred sprawl; harder to test | Almost never — prefer the publication |

**Recommendation: do not implement any of these in v1.** If v2 ever needs cross-project `securities_c` (e.g. a "trade on the institutional side" button in the consumer app), the OEMS publishes to the consumer via a Postgres publication.

---

## 6. Identity / Auth

Supabase Auth is **per-project**: a single human gets a different `auth.users.id` in each project. They are not the same UUID.

| Option | Verdict |
|--------|---------|
| **Two separate Supabase Auth instances** (current state) | **Recommended.** A consumer-app user is a `auth.users` row in the consumer project. An OEMS trader is a `auth.users` row in the MyMint project. They are different people (or at least, different *legal* roles — a retail investor is not a FAIS representative). |
| Single Auth with `user_type` field | Rejected — forces both projects onto one auth project, which is exactly the merge we're avoiding. Also: a single `auth.users` table shared by a retail app and a regulated institutional app makes breach impact much worse. |
| Single Auth with a `profile` per app | Rejected — same reasoning; the gain (one UUID) does not pay for the risk. |

**Practical implication:** a person who has accounts on both apps signs in twice. That is correct: they are two different relationships with two different compliance gates.

### If a single human needs to be a user in both (rare)
- Create a separate `auth.users` row in each project.
- The consumer-side row has Sumsub / TruID / FICA artifacts.
- The OEMS-side row has FAIS representative status / mandate access.
- No link is needed in v1.

---

## 7. KYC / Compliance

| Concern | Consumer | OEMS | Notes |
|---------|----------|------|-------|
| **Sumsub KYC** | ✅ Yes | ❌ No | OEMS users are pre-vetted as FAIS representatives by their employer; no Sumsub. |
| **TruID bank verification** | ✅ Yes | ❌ No | OEMS holds *institutional* bank accounts, not consumer ones. TruID is irrelevant. |
| **FICA / AML on retail flows** | ✅ Yes | ❌ No | Consumer wallets, credit, insurance are FICA-regulated. OEMS order flow is FAIS-regulated (different regime, different authority). |
| **FAIS representative register check** | ❌ No | ✅ Yes | OEMS traders must be on the FAIS rep register; logged in `profiles` role / FSP number. |
| **JSE trader rules** | ❌ No | ✅ Yes | OEMS operators are bound by JSE equities rules; the audit trail in `oems_order_audit` is the regulatory record. |
| **Strate / settlement** | ❌ No | ✅ Yes (downstream) | The OEMS's IPS mirror (`oems_position_c` / `oems_transaction_c`) is the audit-grade view; STRATE settlement is downstream. |

**Conclusion:** the two apps have **non-overlapping KYC regimes.** Merging them would not reduce work — it would entangle two compliance auditors who expect to see *partitionable* books and records.

---

## 8. Migration plan: keep separate (Option B — recommended)

### v1 wiring (this week)

1. **IRESS worker writes only to OEMS tables** (`securities_c`, `stock_intraday_c`, `oems_order_audit`, `integration_worker_health`, `worker_session_metadata`, future `bonds_c` / `jibar_fixing_c` / `news_item_c`). Verify in `workers/iress-ingest/src/env.ts` that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` point at MyMint (`nnwzhxfjpjbzujevwzlh`) and *not* at Eververse (`mfxnghmuccevsxwcetej`). Standing rule already in place.
2. **OEMS reads `securities_c` + `stock_intraday_c` from MyMint** (its own tables). Already true today. No consumer-DB read in the BFF or the worker.
3. **If a user logs into the OEMS**, the OEMS has its own `profiles` table scoped to MyMint Auth users. **No lookup in the consumer DB.** The two `profiles` tables are independent.
4. **Audit the BFF and worker code** for any consumer-DB references (env var `SUPABASE_URL` in Vercel + Railway must point at MyMint, never Eververse). The `docs/ISSUES_LOG.md` §2.10 already flags this. Re-verify.

### Things to *not* do in v1
- Do not create a foreign key or join between MyMint `oems_position_c` and consumer `profiles`.
- Do not write a "shared auth" middleware that hits both Supabase projects on every request.
- Do not copy `securities_c` rows from one project to the other via a worker — the OEMS already has its own.

### What v2 might add
- A Supabase publication from MyMint → consumer for `securities_c` + `stock_intraday_c`, IF the consumer app ever wants a "trade this on the institutional side" cross-link.
- A federated SSO (e.g. a Mint account) that fronts both apps' logins, *but* still provisions separate `auth.users` rows in each project. This is a UX convenience, not a DB merge.
- A read-only "what is the IRESS symbol for ticker X" lookup service exposed by MyMint that the consumer can call. One endpoint, one DTO, no replication.

---

## 9. Migration plan: if a merge is forced (Option A — for the record)

If compliance later reverses course and demands a single project, the merge is *possible* but expensive. Rough order of operations:

1. **Choose canonical project.** MyMint has the cleaner schema (more recent, IRESS-instrumented, idempotent migrations, RLS by design). Migrate consumer tables into MyMint.
2. **Reconcile schema drift.** For every OVERLAP table in §4, pick a canonical column set and write a `*_migrate_consumer_to_mymint.sql` script. Run it in a transaction with a rollback plan.
3. **Re-issue Supabase Auth keys.** Re-create the consumer users in MyMint Auth (different UUIDs); preserve email-as-link in a `legacy_user_map` table.
4. **Update RLS policies.** The consumer's RLS assumes `auth.uid() = profiles.id` retail semantics; the OEMS's RLS assumes service_role writes + trader reads. A new top-level `app_memberships` table + RLS predicates (`WHERE EXISTS (SELECT 1 FROM app_memberships m WHERE m.user_id = auth.uid() AND m.app = current_app())`) replaces both.
5. **Update server-side code.**
   - The IRESS worker already writes to MyMint; no change.
   - The consumer app's server code (BFFs, edge functions) needs `SUPABASE_URL` re-pointed to MyMint + new service-role key.
   - The `supabase_creds` file in the repo root needs updating.
6. **Backups and rollback.** The consumer project becomes a *read-only archive* for 90 days. Do not delete until audit sign-off.
7. **Compliance notification.** FAIS / FSCA / JSE all need to be told the books-and-records boundary moved. This is the *real* cost — not the SQL migration.

**Estimated effort: 6–10 weeks for a clean merge, plus a 4-week compliance review.** This is the cost of saying yes to Option A. Option B costs ~1 hour (a one-line env-var audit).

---

## 10. Data-flow question answers

| Q | A | Reason |
|---|-----|--------|
| Does the OEMS need to see `transactions` (consumer's money movement)? | **No.** | The OEMS is upstream of order routing, not downstream of consumer settlement. A consumer's R5 000 wallet debit has nothing to do with a JSE working pad. |
| Does the consumer app need to see `oems_order_audit`? | **No in v1.** | An OEMS user (institutional) places a child order; that order is *not* a retail flow. If a retail user is ever a *beneficiary* of an institutional mandate, the consumer app reads the *mandate* surface, not the order audit. |
| Does the OEMS need to see `gift_claims`? | **No.** | Gifting is a consumer-only flow. |
| Does the OEMS need to see `investment_goals`? | **No in v1.** | Could model "institutional mandate objectives" as goals in v2, but v1 is silent. |
| Does the OEMS need to see `insurance_policies` / `loan_application` / `credit_accounts`? | **No.** | Pure consumer products. No OEMS read. |
| Does the OEMS need to see `family_members`? | **No.** | Family-account concept. |
| Does the OEMS need to see `news_articles` (consumer's)? | **No.** | The OEMS has its own vendor-fed `news_item_c` (SENS / Reuters / Bloomberg). Different taxonomy, different source. |
| Does the OEMS need to see the consumer's `strategies_c` / `user_strategies`? | **No.** | Different concept (retail product vs institutional mandate rollup). |

---

## 11. Risks and mitigations (Option B)

| Risk | Mitigation |
|------|------------|
| `securities_c` drift between the two projects | Diff the schemas once (this week); if the consumer's is a JSE retail subset, document the canonical symbol universe in the OEMS and add the missing tickers to the OEMS worker watchlist. |
| An OEMS engineer accidentally writes a BFF that reads the consumer DB | Lint rule + CI guard: any Vercel or Railway deployment that resolves `SUPABASE_URL` to `mfxnghmuccevsxwcetej.supabase.co` fails the build. Already partially covered by `docs/ISSUES_LOG.md` §2.10. |
| A retail user wants to view their institutional portfolio in the consumer app | v2 problem. Implement as a separate OEMS-fed surface, not a SQL cross-join. |
| A trader wants to view a retail user's holdings | Out of scope: an institutional trader has no business viewing a retail investor's wallet. Compliance veto. |
| Schema-evolution collision (both projects add a column to `securities_c`) | Document the OEMS schema as canonical; the consumer's is allowed to drift in retail-only columns. |
| Disaster recovery on the OEMS project | The OEMS `securities_c` and `stock_intraday_c` can be reseeded from IRESS by the worker on first boot. The consumer project has its own DR. Independent backup stories. |

---

## 12. The 3-paragraph executive summary (paste-ready for the user)

**Recommendation: keep the two Supabase projects separate.** The Mint consumer app (Eververse, `mfxnghmuccevsxwcetej`) and the MyMint OEMS (`nnwzhxfjpjbzujevwzlh`) serve different users — retail investors vs. institutional trader representatives — under different compliance regimes (FSCA retail vs. FAIS representative + JSE trader rules), with already-divergent schemas (the OEMS's `securities_c` has RIC, ISIN, sector refdata the consumer does not). A merge would entangle two compliance auditors who expect to see *partitionable* books and records, force a single RLS regime to police two unrelated trust models, and cost 6–10 weeks of SQL migration + a 4-week compliance review for no business gain in v1. The OEMS's `securities_c` is strictly more capable than the consumer's (IRESS-fed, RIC + ISIN + sector), so the OEMS does not even benefit from a read-replica of the consumer's catalogue.

**This week: (1) make the decision in writing by pasting this report into the MyMint team's `PLANNING.md` / project README; (2) verify the IRESS worker's `SUPABASE_URL` and the Vercel BFF's `SUPABASE_URL` both point at MyMint (`nnwzhxfjpjbzujevwzlh`) and never at Eververse — this is the standing rule and the `ISSUES_LOG.md` already flags it; (3) diff the two projects' `securities_c` schemas and row sets once with `supabase db diff`-style tooling so the OEMS worker watchlist is confirmed as the canonical JSE symbol universe.** None of these is more than a few hours of work.

**What can wait: a cross-project auth / SSO federation (single Mint account fronting both apps) is a v2 problem, not a v1 problem. The two apps do not need a shared user table, a shared `securities_c` publication, or a shared storage bucket. If a retail user is ever added to the OEMS, that is built as a federation pattern on top of the two projects, not as a schema merge.**

---

## 13. Decision log (for the project README)

```
2026-06-13: Decision recorded. Mint consumer (mfxnghmuccevsxwcetej) and MyMint OEMS
            (nnwzhxfjpjbzujevwzlh) remain separate Supabase projects. See
            wealth-navigator/docs/TWO_DB_STRATEGY.md. The OEMS's securities_c is
            the canonical JSE instrument catalogue; the consumer's is a retail
            subset and does not feed the OEMS. No cross-project writes in v1.
            Re-review: only if compliance forces a books-and-records unification
            or if a retail↔institutional cross-link is added to the consumer app.
```

---

*Last updated: 2026-06-13. Author: DB architecture review pass against the consumer-app reference doc and the MyMint OEMS migration set.*
