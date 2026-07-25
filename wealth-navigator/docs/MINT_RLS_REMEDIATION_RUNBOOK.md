# MINT RETAIL — RLS Remediation Runbook (client-data exposure fix)

**Target DB:** RETAIL prod `mfxnghmuccevsxwcetej`.
**Why:** RLS is OFF on ~28 public tables and `anon`+`authenticated` hold full CRUD (verified via
`has_table_privilege()`); the MINT browser ships the retail anon key, so **anyone can read/write
`wallets`, bank (`truid_bank_snapshots`), credit, loans & KYC**.
**The trap:** the MINT client does **direct client-side reads AND writes** on many of these tables
(verified by grepping `.from("…")` across `MINT-DEVELOPMENT/src`). So a blind "enable RLS + revoke"
lockdown WILL break loan applications, credit, gifting, onboarding and the dashboards. Policies must
**match the observed access**, and this MUST be validated on a Supabase **preview branch** before prod.

> ⚠️ These policies are DRAFT, derived from static analysis. **Do not paste into prod.** Run them on a
> preview branch, execute the smoke-test checklist, fix anything that 401/403s, then promote.

---

## Observed client access (evidence for the categories below)
- **Read-only reference (client reads, server writes):** `stock_intraday_c`, `stock_returns_c`,
  `strategies_c`, `strategies_returns_c`, `News_articles`, `transaction_categories`,
  `alliance_news_codes`, `email_categories`, `email_templates` — read across marketData.js,
  strategyData.js, HomePage, MarketsPage, SwipeableBalanceCard, ChildDashboard, etc.
- **Owner-scoped, client READS own rows:** `wallets` (useFinancialData, useProfile, Withdraw, Gift…),
  `loan_engine_score`, `strategy_aum_fee_state` (strategyValuation.js).
- **Owner-scoped, client READS + WRITES own rows:** `loan_application` (insert/update across the credit
  flows), `credit_transactions_history` (insert), `truid_bank_snapshots`, `user_onboarding_pack_details`.
- **No client access found → server-only (service-role):** `email_queue`, `email_campaigns`,
  `mint_revenue_daily`, `dividend_runs`, `dividend_payouts_staging`, `approval_templates`,
  `mint_mornings_log`, `aum_fee_transactions`, `aum_fee_accrual_segments`, `buffer_drawdowns_c`,
  `user_email_preferences`. *(Not seen in the grep — VERIFY on preview before locking.)*
- **Flagged / needs a decision:** `admin_approvals` (client INSERTs, but has **no** owner column).

---

## GROUP 1 — Public read-only reference (reads preserved, writes closed)
These carry no per-user secrets (market data / catalogs); the fix keeps reads open and shuts the
**write** hole. Run per table (`T` = each name):
```sql
ALTER TABLE public."T" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_all" ON public."T" FOR SELECT USING (true);         -- anon + authenticated can read
REVOKE INSERT, UPDATE, DELETE ON public."T" FROM anon, authenticated;   -- writes only via service-role
```
Tables: `stock_intraday_c`, `stock_returns_c`, `strategies_c`, `strategies_returns_c`,
`transaction_categories`, `alliance_news_codes`, `email_categories`, `email_templates`.
`News_articles`: same, but first confirm `src/utils/populateNews.js` is an admin/seed path, not a
client path (it writes `News_articles`); if it runs client-side, keep an admin-only write policy.

## GROUP 2 — Owner-scoped user data
`auth.uid()` comes from the logged-in user's JWT (MINT uses Supabase Auth), so owner policies work on
the client. `(select auth.uid())` form avoids the `auth_rls_initplan` per-row perf hit.

**2a — client READS + WRITES own rows** (`loan_application`, `credit_transactions_history`,
`truid_bank_snapshots`, `user_onboarding_pack_details`):
```sql
ALTER TABLE public."T" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_sel" ON public."T" FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY "own_ins" ON public."T" FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "own_upd" ON public."T" FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
REVOKE ALL ON public."T" FROM anon;
```
> Verify each client INSERT actually sets `user_id` to the logged-in user (else `own_ins` rejects it).
> If any admin/staff needs cross-user access, add an admin policy (see 2c).

**2b — client READS own rows only** (`wallets`, `loan_engine_score`, `strategy_aum_fee_state`):
```sql
ALTER TABLE public."T" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_sel" ON public."T" FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
REVOKE ALL ON public."T" FROM anon;   -- writes stay with service-role
```
For tables that ALSO have `family_member_id` (parent viewing a child: `strategy_aum_fee_state`,
`buffer_drawdowns_c`, `aum_fee_*`), broaden the read predicate:
```sql
USING (user_id = (select auth.uid())
       OR family_member_id IN (SELECT id FROM public.family_members WHERE primary_user_id = (select auth.uid())))
```

**2c — admin/staff cross-user read** (reuse everywhere an admin must see all rows):
```sql
CREATE POLICY "admin_all" ON public."T" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.user_id = (select auth.uid())));
```

## GROUP 3 — Server-only (service-role bypasses RLS)
No client access found → lock to the BFF/worker service-role only:
```sql
ALTER TABLE public."T" ENABLE ROW LEVEL SECURITY;   -- no anon/authenticated policy = deny for them
REVOKE ALL ON public."T" FROM anon, authenticated;
```
Tables: `email_queue`, `email_campaigns`, `mint_revenue_daily`, `dividend_runs`,
`dividend_payouts_staging`, `approval_templates`, `mint_mornings_log`, `aum_fee_transactions`,
`aum_fee_accrual_segments`, `buffer_drawdowns_c`, `user_email_preferences`.
> `user_email_preferences` may be client-managed — if the app lets a user edit their own prefs
> client-side, move it to GROUP 2a instead. Confirm on preview.

## GROUP 4 — Fix the "policy exists but RLS off" tables (don't just flip RLS on)
`loan_application`, `loan_engine_score`, `News_articles`, `transaction_categories` already have a
policy but RLS is disabled. **Inspect the existing policy first** — the audit flagged a
`"Staff view … USING (true)"` policy that exposes *every* customer to any logged-in user:
```sql
SELECT tablename, policyname, cmd, roles, qual FROM pg_policies
WHERE schemaname='public' AND tablename IN ('loan_application','loan_engine_score','News_articles','transaction_categories');
```
Replace any `USING (true)` on customer tables with the owner/admin predicates above **before** enabling RLS.

## GROUP 5 — Flagged: `admin_approvals` (client INSERT, no owner column)
The client inserts approval requests but the table has no `user_id`. Decide the intended model:
- Preferred: add a `requested_by uuid default auth.uid()` column, then
  `FOR INSERT TO authenticated WITH CHECK (requested_by = (select auth.uid()))` + admin-only SELECT.
- Interim: `FOR INSERT TO authenticated WITH CHECK (true)` (anyone logged-in may request) + admin-only SELECT.
This one needs a product decision — do it last, on the branch.

---

## MANDATORY procedure (this is what guarantees "nothing breaks")
1. **Create a Supabase preview branch** of the retail project (Dashboard → Branches). It clones schema;
   seed/copy a little test data or point a MINT **dev** build at the branch.
2. **Apply GROUP 1–5 SQL** on the branch.
3. **Smoke test as a real logged-in user** (must all succeed, no 401/403/empty):
   - Login → Home (prices, News, strategies, balance card).
   - Portfolio / Markets (stock_intraday_c, stock_returns_c, strategies_c).
   - Wallet balance + a deposit/gift flow (wallets).
   - **Credit apply end-to-end** (loan_application insert/update, truid_bank_snapshots, loan_engine_score,
     credit_transactions_history insert) — this touches the most policies.
   - Onboarding (user_onboarding_pack_details write).
   - Child dashboard (family_member_id read path).
   - Admin/CRM (WN uses service-role → should be unaffected; confirm).
4. **Fix** any policy that blocked a legitimate op; re-test.
5. **Cross-check the hole is closed:** with the **anon** key (no user JWT), `SELECT` on `wallets`
   must return 0 rows / permission denied.
6. **Promote to prod** (paste the validated SQL in the prod SQL editor) in a low-traffic window; watch
   `get_advisors(security)` drop and error rates.

## Rollback (instant, per table)
```sql
ALTER TABLE public."T" DISABLE ROW LEVEL SECURITY;
```

---
*Companion: MINT_PRODUCTION_READINESS_AUDIT.md (P0.1). Prepared from static analysis — the preview
smoke test is authoritative. Do the owner-scoped credit/wallet/KYC tables first (highest exposure).*
