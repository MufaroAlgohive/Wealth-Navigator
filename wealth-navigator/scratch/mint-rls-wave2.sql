-- ============================================================================
-- MINT RETAIL RLS — WAVE 2 (sensitive owner tables: wallets / credit / loans / KYC / fees)
-- Apply on a Supabase PREVIEW BRANCH first, run the app smoke tests, THEN promote to prod.
-- Auto-assembled from per-table adversarially-verified policies (10-agent workflow).
-- Review the per-table flags/caveats before running.
-- ============================================================================


-- ============================================================
-- TABLE: wallets  [owner_read_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Adversarial self-check — every client site passes: sites 1-5,7-11 are owner SELECT (user_id=auth.uid()) -> wallets_select_own. Site 6 (.in user_id [own+spouse]) -> own via policy 1, spouse via policy 2. No client writes exist, so the absence of write policies breaks nothing. anon has ALL revoked -> cannot read or write (exposure closed); RLS is currently OFF with anon/authenticated holding full CRUD (verified via has_table_privilege).
--   
--   Edge cases:
--   - wallets.user_id is NOT NULL -> no null-owner row can leak.
--   - Spouse read is one-directional. Verified in prod data: 3 rows relationship='spouse' with linked_user_id, 0 reciprocal. So a linked spouse logging in gets empty spouseUserIds and only reads their own wallet (policy 1). If the product later wants the spouse to view the PRIMARY's wallet, a mirror policy (user_id IN (select primary_user_id from family_members where linked_user_id = auth.uid())) would be required — not needed today.
--   - Children have NO wallets row of their own for the client path: child balances live in family_members.available_balance, and the child-wallet client read goes through /api/child-wallet (service role). wallets has no family_member_id column, so no parent->child wallet policy is needed.
--   - Policy 2 subquery reads public.family_members. Today family_members RLS is OFF so the subquery sees all rows. When family_members later gets RLS, ensure the primary user can SELECT their own family_members rows (standard owner policy) or wallets_select_spouse will silently return no spouse rows -> a soft break of the Family Dashboard spouse balance (rows dropped, not an error).
--   - Uses the (select auth.uid()) sub-select form to avoid the auth_rls_initplan per-row re-evaluation perf hit.
-- ------------------------------------------------------------
-- wallets: client only READS (own wallet + linked spouse's wallet); all writes are server/service-role.
ALTER TABLE public."wallets" ENABLE ROW LEVEL SECURITY;

-- 1) Owner reads own wallet (covers sites 1-5,7-11 and the 'own' element of site 6).
CREATE POLICY "wallets_select_own" ON public."wallets"
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

-- 2) Primary user reads their linked spouse's wallet (site 6, FamilyDashboardPage:1184).
--    One-directional by design: matches how the client builds walletUserIds
--    (spouse linked_user_id only). Confirmed 3 spouse links, 0 reciprocal, so the
--    linked spouse only ever reads their OWN wallet (covered by policy 1).
CREATE POLICY "wallets_select_spouse" ON public."wallets"
  FOR SELECT TO authenticated
  USING (
    user_id IN (
      select fm.linked_user_id
      from public.family_members fm
      where fm.primary_user_id = (select auth.uid())
        and fm.relationship = 'spouse'
        and fm.linked_user_id is not null
    )
  );

-- No INSERT/UPDATE/DELETE policies: the client performs no writes; all mutations run
-- through the service-role BFF/worker which bypass RLS.
-- No admin SELECT policy: admin reads of wallets go through the WN service-role BFF, not a client.

-- Close the anon-key exposure and strip client write grants (defense-in-depth;
-- writes are already denied by RLS since no write policy exists).
REVOKE ALL ON public."wallets" FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public."wallets" FROM authenticated;
-- (authenticated retains its SELECT grant; service_role grants unchanged.)

-- ============================================================
-- TABLE: loan_application  [owner_read_write]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Adversarial self-check: all 23 client sites pass. Owner SELECT covers every eq(user_id) read AND the by-id reads (loanApplication.js:54, UnsecuredCreditDashboard.jsx:748, ActiveLiquidity.jsx:51) because the id always belongs to the caller; a foreign id simply returns empty (acceptable, matches intent). All INSERTs set user_id to auth.uid() so WITH CHECK passes (profile.id===auth.uid() verified via profiles.id=session.user.id). UPDATE/DELETE are by id on owned rows; UPDATE also has WITH CHECK to block ownership reassignment. MUST-DO: the DROP POLICY of "Staff view applications" is mandatory FIRST -- it currently exists (dormant while RLS is off) and would allow cross-user KYC reads the instant RLS is enabled. No family_member_id column on this table, so no parent->child policy is needed (credit product is parent-only per InstantLiquidity.jsx:186). No client-side admin read exists (WN admin uses createRetailServiceRoleClient which bypasses RLS), so intentionally NO admin SELECT policy is added. user_id is NOT NULL so there are no null-owner rows to orphan. anon currently has effective SELECT/INSERT/UPDATE/DELETE (has_table_privilege=true); REVOKE ALL FROM anon plus RLS closes the anon-key exposure fully. ActiveLiquidity.jsx:51 also joins pbc_collateral_pledges (separate table, out of scope here -- ensure it gets its own owner policy or the embed will return empty).
-- ------------------------------------------------------------
-- loan_application: owner_read_write. RETAIL prod (mfxnghmuccevsxwcetej).
-- STEP 1: drop the pre-existing over-permissive policy that would leak all KYC.
-- "Staff view applications" is SELECT / role authenticated / USING (true):
-- with RLS ON it lets ANY logged-in user read EVERY applicant's row. Must go.
DROP POLICY IF EXISTS "Staff view applications" ON public.loan_application;

-- STEP 2: turn on RLS.
ALTER TABLE public.loan_application ENABLE ROW LEVEL SECURITY;

-- STEP 3: owner-scoped policies (client runs as role 'authenticated').
CREATE POLICY loan_application_owner_select ON public.loan_application
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

CREATE POLICY loan_application_owner_insert ON public.loan_application
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY loan_application_owner_update ON public.loan_application
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY loan_application_owner_delete ON public.loan_application
  FOR DELETE TO authenticated
  USING (user_id = (select auth.uid()));

-- STEP 4: cut the anon key off entirely (it should never touch this table).
REVOKE ALL ON public.loan_application FROM anon;
-- (authenticated keeps its grants; RLS owner policies constrain it. service_role bypasses RLS.)

-- ============================================================
-- TABLE: loan_engine_score  [owner_read_write]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: No legitimate client op is blocked. Adversarial per-site verification: sites 1,2,5,6,7 (SELECT filtered by user_id=auth.uid()) pass select_own. Site 4 INSERT sets user_id=userId=auth.uid() -> passes insert_own WITH CHECK. Site 3 UPDATE filters only by .eq('id', existingScore.id): USING evaluates the pre-existing row's user_id, and that row was fetched at :1767 under a user_id=userId scope so it belongs to the caller -> USING passes; the update payload never sets/changes user_id -> WITH CHECK (user_id=auth.uid()) still passes. No DELETE anywhere, so omitting a DELETE policy denies deletes (default-deny) without breaking the client.
--   Edge cases: (a) Rows with NULL user_id become invisible/unwritable to all clients (auth.uid() != NULL); this is acceptable because every client query filters by user_id and such orphan rows would only be created/read by the service-role backend, which bypasses RLS. (b) No family/parent-child access is needed: loan_engine_score has only user_id (no family_member_id), and it is only ever read for the logged-in adult applicant, so no family_members join policy is required. (c) No client-side admin SELECT exists (WN admin reads go through the service-role BFF, which bypasses RLS), so no admin_profiles policy is added. (d) REVOKE ALL ... FROM anon plus RLS (all policies require a non-null auth.uid()) means the anon key can no longer read or write; authenticated users retain existing table grants but are constrained to their own rows. (e) If any Postgres GRANT to anon is later re-added, RLS still blocks anon because no policy can be satisfied with a null auth.uid(); the REVOKE is defense-in-depth. (f) Confirm the app never calls this table with the anon/public client before an auth session exists (all 7 sites first resolve session.user.id / profile.id and early-return when absent, so this holds).
-- ------------------------------------------------------------
-- loan_engine_score: owner_read_write. Client (MINT) does owner-scoped SELECT/INSERT/UPDATE via user_id = auth.uid().
-- WN admin/BFF uses service-role and bypasses RLS, so no admin policy is added here.
ALTER TABLE public."loan_engine_score" ENABLE ROW LEVEL SECURITY;

-- Owner can read own rows (sites 1,2,5,6,7)
CREATE POLICY "loan_engine_score_select_own"
  ON public."loan_engine_score"
  FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

-- Owner can insert rows for themselves (site 4 sets user_id explicitly)
CREATE POLICY "loan_engine_score_insert_own"
  ON public."loan_engine_score"
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

-- Owner can update own rows; cannot reassign ownership (site 3 filters by id, payload leaves user_id unchanged)
CREATE POLICY "loan_engine_score_update_own"
  ON public."loan_engine_score"
  FOR UPDATE
  TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- No DELETE policy: the client never deletes from this table.
-- Close the anon-key hole: anon must never reach this KYC/credit table.
REVOKE ALL ON public."loan_engine_score" FROM anon;

-- ============================================================
-- TABLE: credit_transactions_history  [owner_read_write]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Adversarial self-check per site — all 7 legitimate client ops pass:
--   - 5 INSERTs (CreditApplyPage:1928, ActiveLiquidity:191, InstantLiquidity:337, RepayLiquidity:113, UnsecuredCreditDashboard:729) each set user_id to the logged-in user (userId/profile.id = auth.uid()), so WITH CHECK (user_id = auth.uid()) passes.
--   - 2 SELECTs (LiquidityHistory:22, UnsecuredCreditDashboard:225) both filter .eq('user_id', profile.id); USING (user_id = auth.uid()) returns exactly those rows.
--   No UPDATE/DELETE client op exists, so omitting those policies breaks nothing.
--   anon: REVOKE ALL removes all table privileges AND RLS has no anon-facing policy, so the anon key can neither read nor write — anon exposure closed.
--   DEPENDENCY: correctness relies on profile.id === auth.uid(). Verified: src/lib/useProfile.js line 71 calls supabase.auth.getUser() and builds the profile with id = user.id (lines 87/97/135). If any deployment ever set user_id to a non-auth id, INSERT would fail — but current code does not.
--   FORCE RLS is included so the table owner role is also subject to RLS; drop it only if migrations run as table owner and need to bypass (service-role uses a separate role and bypasses regardless).
-- ------------------------------------------------------------
-- credit_transactions_history: client does owner-scoped SELECT + INSERT only (no UPDATE/DELETE).
-- WN admin/BFF uses service-role client which BYPASSES RLS, so no admin/server policies needed.
ALTER TABLE public."credit_transactions_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."credit_transactions_history" FORCE ROW LEVEL SECURITY;

-- Owner can read only their own ledger rows.
CREATE POLICY "cth_owner_select"
  ON public."credit_transactions_history"
  FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

-- Owner can insert only rows stamped with their own user_id.
CREATE POLICY "cth_owner_insert"
  ON public."credit_transactions_history"
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

-- No UPDATE or DELETE policy: RLS default-denies these; client never issues them.

-- Close the anon-key exposure and strip unused authenticated write privileges.
REVOKE ALL ON public."credit_transactions_history" FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public."credit_transactions_history" FROM authenticated;
GRANT SELECT, INSERT ON public."credit_transactions_history" TO authenticated;

-- ============================================================
-- TABLE: truid_bank_snapshots  [owner_read_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Adversarial self-check: each of the 4 client sites filters .eq('user_id', <auth.uid()>) and reads only the caller's own rows, all of which the owner_select policy (user_id = (select auth.uid())) permits — no site is blocked. profile.id in UnsecuredCreditDashboard.jsx and InstantLiquidity.jsx is the logged-in user's own profile prop (single-user client; equals auth.uid()); there is no client path that reads another user's snapshot, so the absence of an admin/parent policy breaks nothing. This table has no family_member_id column, so no parent->child family access is needed. Edge case: rows with a NULL user_id would be invisible to every client read, but the client only ever queries its own user_id, so this changes no current behavior (and such rows were already unreachable by these filters). If a future client feature needs to WRITE this table directly, it would be blocked (currently none does — writes are service-role only). closes_anon_exposure=true: after REVOKE, anon has no grant and no policy, and authenticated is limited by RLS to owner rows, so the anon key can no longer read or write.
-- ------------------------------------------------------------
-- truid_bank_snapshots: client does OWNER-SCOPED READS ONLY. Writes are server-side (service-role, bypasses RLS).
ALTER TABLE public."truid_bank_snapshots" ENABLE ROW LEVEL SECURITY;

-- Owner can read their own snapshots (covers all 4 client SELECT sites).
CREATE POLICY "truid_bank_snapshots_owner_select"
  ON public."truid_bank_snapshots"
  FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

-- NO client write policies: the client never inserts/updates/deletes this table; the TruID webhook/BFF uses the service-role key which bypasses RLS.
-- NO admin SELECT policy: admin cross-user reads go through the WN service-role BFF, not a client-side admin read.

-- Close anon-key exposure: strip all anon grants so RLS default-deny plus no grant leaves anon with zero access.
REVOKE ALL ON public."truid_bank_snapshots" FROM anon;

-- ============================================================
-- TABLE: user_onboarding_pack_details  [owner_read_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Adversarial per-site check: (1) AccountAgreementStep.jsx:501 SELECT eq user_id=uid -> allowed by uopd_owner_select. (2) useCreditCheck.js:195 SELECT eq user_id=session.user.id -> allowed. (3) UserOnboardingPage.jsx:763 SELECT eq user_id=userId -> allowed. All three read only auth.uid()'s own row, so the owner USING clause permits them exactly. All WN upserts/selects run under service-role and bypass RLS -> unaffected. No legitimate client op is blocked; breaks_client=false. anon: REVOKE ALL FROM anon removes the current full-CRUD anon exposure; with RLS on and only an authenticated-scoped SELECT policy, the anon key can neither read nor write -> closes_anon_exposure=true. The extra REVOKE INSERT/UPDATE/DELETE FROM authenticated is defense-in-depth (no write policy already blocks writes, but stripping the grant avoids relying solely on policy absence); SELECT grant to authenticated is retained and required for the policy to function.
-- ------------------------------------------------------------
ALTER TABLE public."user_onboarding_pack_details" ENABLE ROW LEVEL SECURITY;

-- Owner can read only their own onboarding pack row.
CREATE POLICY "uopd_owner_select"
  ON public."user_onboarding_pack_details"
  FOR SELECT
  TO authenticated
  USING ( user_id = (select auth.uid()) );

-- Remove all anon-key access; MINT client reads as an authenticated JWT, never anon.
REVOKE ALL ON public."user_onboarding_pack_details" FROM anon;

-- No INSERT/UPDATE/DELETE policy: every client write to this table is performed by the
-- WN service-role client (createRetailServiceRoleClient), which bypasses RLS. With RLS enabled
-- and no write policy, authenticated (anon-key) clients cannot write, which matches app behavior
-- (no client-side write site exists). Optionally also lock down leftover write grants:
REVOKE INSERT, UPDATE, DELETE ON public."user_onboarding_pack_details" FROM authenticated;

-- ============================================================
-- TABLE: strategy_aum_fee_state  [owner_read_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Adversarial self-check of the single client site (strategyValuation.js:106-107): SELF branch (user_id=userId & family_member_id IS NULL) is permitted by user_id = auth.uid(). FAMILY branch (.eq family_member_id, no user_id filter) is permitted by the family_members sub-select. Both legitimate reads pass -> no breakage. In practice MINT stores family-member fee rows under the PARENT user_id with family_member_id set, so user_id=auth.uid() alone would already cover the family branch; the family_members clause is redundant-but-harmless insurance in case any row is stored under a child's own auth user. Anon: REVOKE ALL FROM anon + RLS on => anon key (no login) gets permission-denied on read AND write, closing the exposure. authenticated has SELECT-only grant and no write policy => inserts/updates/deletes are denied (RLS default-deny). Edge: rows with user_id NULL and family_member_id NULL are unreadable by any client, but the client never requests such rows. Confidence high (single unambiguous client read). Note: MINT-DEVELOPMENT/api/user/strategies.js falls back to the anon `supabase` if supabaseAdmin is unset (const db = supabaseAdmin||supabase, line 48) — that path is server-side and authenticates the request first, but if service-role env is missing in that deployment the fallback anon read would now be RLS-scoped; ensure SUPABASE_SERVICE_ROLE is set for the MINT api runtime.
-- ------------------------------------------------------------
-- strategy_aum_fee_state: owner read-only + parent(family) read; all writes are server/service-role
ALTER TABLE public."strategy_aum_fee_state" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "saffs_select_owner_or_parent"
  ON public."strategy_aum_fee_state"
  FOR SELECT
  TO authenticated
  USING (
    user_id = (select auth.uid())
    OR family_member_id IN (
      select fm.id from public.family_members fm
      where fm.primary_user_id = (select auth.uid())
    )
  );

-- lock everything the client must not do
REVOKE ALL ON public."strategy_aum_fee_state" FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."strategy_aum_fee_state" FROM authenticated;
GRANT SELECT ON public."strategy_aum_fee_state" TO authenticated;
-- service_role bypasses RLS (BYPASSRLS) and keeps its grant; do NOT add policies for it.

-- ============================================================
-- TABLE: buffer_drawdowns_c  [server_role_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: No client operation exists to break. RLS ENABLE with zero policies = default-deny for anon and authenticated; REVOKE ALL removes even the attempt. service_role (BYPASSRLS) accrual engine unaffected. Owner columns (user_id, family_member_id) are present so an owner-scoped SELECT policy could be added later if a client fee/drawdown-history UI is ever built, but none exists today. Confidence high only insofar as an explicit-string grep can prove absence — if the app ever accesses this table via a dynamically-built table name (variable passed to .from()), that would not appear in this grep; none was observed.
-- ------------------------------------------------------------
-- buffer_drawdowns_c: no client access at all -> default-deny for anon+authenticated, service_role only
ALTER TABLE public."buffer_drawdowns_c" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."buffer_drawdowns_c" FROM anon, authenticated;
-- Intentionally NO policies: RLS default-deny blocks all anon/authenticated rows.
-- service_role bypasses RLS and retains its grant.

-- ============================================================
-- TABLE: aum_fee_transactions  [server_role_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: The only writer (aumFeeEngine.cjs:226 insert) uses the service-role client, which bypasses RLS, so enabling RLS with no policies does not affect it. No client read exists, so no owner SELECT policy is needed; owner columns (user_id, family_member_id) exist if a client-facing fee-transaction history is added later. anon+authenticated fully denied => anon-key exposure closed. Same absence-of-evidence caveat re: dynamic table names as buffer_drawdowns_c; none observed. Confidence high.
-- ------------------------------------------------------------
-- aum_fee_transactions: server/service-role writes only, no client access
ALTER TABLE public."aum_fee_transactions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."aum_fee_transactions" FROM anon, authenticated;
-- No policies: default-deny for anon+authenticated. service_role bypasses RLS.

-- ============================================================
-- TABLE: aum_fee_accrual_segments  [server_role_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: All reads/writes to this table are performed by the service-role accrual engine (aumFeeEngine.cjs), which bypasses RLS; enabling RLS with no policies leaves the engine fully functional. No browser-client op exists, so nothing to break and no owner policy needed (user_id, family_member_id columns exist for future client use). anon+authenticated denied => anon-key exposure closed. Same dynamic-table-name absence caveat; none observed. Confidence high.
-- ------------------------------------------------------------
-- aum_fee_accrual_segments: server/service-role only, no client access
ALTER TABLE public."aum_fee_accrual_segments" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."aum_fee_accrual_segments" FROM anon, authenticated;
-- No policies: default-deny for anon+authenticated. service_role bypasses RLS.

-- ============================================================
-- TABLE: admin_approvals  [server_role_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: NO owner column usable for RLS: schema has requested_by_id (nullable) but the ONLY client write (LiquidityFlow.jsx:487) never sets it and instead targets 4 non-existent columns (user_id, loan_application_id, amount, admin_notes). That INSERT therefore already fails today (PGRST204) independent of RLS, and its error is silently swallowed (return value never checked; flow proceeds to onNext). Enabling RLS + no INSERT policy blocks that call, but it blocks nothing that currently WORKS — hence breaks_client=false. 
--   
--   WARNING for the future: if someone later 'fixes' LiquidityFlow.jsx to insert with the real columns (requested_by_id/type/payload) using the anon/authenticated client, this deny-all config WOULD block it. The correct fix for that flow is to route the approval creation through a service-role BFF endpoint (as the rest of the admin_approvals lifecycle already is), NOT to add a client INSERT policy. If product decides end-users must self-create approvals client-side, revisit: add `CREATE POLICY approvals_insert_self ON public.admin_approvals FOR INSERT TO authenticated WITH CHECK (requested_by_id = (select auth.uid()))` and re-GRANT INSERT to authenticated — but that is out of scope for closing the current anon exposure.
--   
--   All WN admin SELECT/UPDATE (team/route.ts, action-items/route.ts) use createRetailServiceRoleClient and are unaffected by RLS. No family_members or admin_profiles logic applies (no client cross-user access exists). FORCE ROW LEVEL SECURITY is included as optional; drop it if any non-service_role trusted job (e.g. a DB-owner cron) writes this table.
-- ------------------------------------------------------------
-- admin_approvals: server/BFF-managed approval queue. No legitimate client (anon/authenticated) op exists.
-- WN admin reads/writes go through the service-role BFF, which BYPASSES RLS, so NO policies are required.
-- Enabling RLS with zero policies denies all anon/authenticated access (default-deny); service_role is unaffected.

ALTER TABLE public."admin_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admin_approvals" FORCE ROW LEVEL SECURITY; -- optional hardening; note it also constrains table owner, NOT service_role (service_role bypasses via BYPASSRLS)

-- Defense-in-depth: strip the API-facing roles' grants so the anon/authenticated key cannot touch the table at all.
REVOKE ALL ON public."admin_approvals" FROM anon;
REVOKE ALL ON public."admin_approvals" FROM authenticated;

-- (No CREATE POLICY statements: there is no legitimate owner-scoped, family, or client-admin read/write to permit.)
-- service_role retains full access (bypasses RLS + retains its grants), so the WN BFF is unaffected.

-- ============================================================
-- TABLE: strategies_c  [reference_public_read]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Verified safe: MINT reaches FactsheetPage/MarketsPage/etc. only via in-app state navigation (navigateTo('factsheet')) after login — there is no public/anon React route serving these reads, so authenticated-only SELECT does not break any current flow. Notes: (1) No user_id column exists, so reads cannot be owner-scoped — USING(true) for authenticated is the correct minimal grant for reference/catalog data. (2) Catalog is NOT written client-side; all mutations go through the WN service-role admin BFF, so no client INSERT/UPDATE/DELETE policy is needed or wanted. (3) No client-side admin read exists (admin reads are the service-role BFF), so no admin_profiles SELECT policy is added. (4) If a logged-out marketing/factsheet page is ever added, it will need either an anon SELECT policy or a security-definer view — do not silently re-grant anon.
-- ------------------------------------------------------------
-- strategies_c: public strategy catalog (no ownership/user_id column).
-- Client (MINT, authenticated JWT) does SELECT-only; every write is WN service-role (bypasses RLS).
ALTER TABLE public."strategies_c" ENABLE ROW LEVEL SECURITY;

-- Any logged-in user may read the catalog. Reads are not owner-scoped and several sites
-- fetch by id/slug without is_public=true, so the policy must be catalog-wide (USING true).
CREATE POLICY "strategies_c_authenticated_select"
  ON public."strategies_c"
  FOR SELECT
  TO authenticated
  USING (true);

-- Close the anon-key exposure and strip client write grants (writes are service-role only).
REVOKE ALL ON public."strategies_c" FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public."strategies_c" FROM authenticated;

-- ============================================================
-- TABLE: strategies_returns_c  [server_role_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Verified via pg_class: strategy_returns_effective_c is a VIEW with reloptions security_invoker='false', so enabling RLS + deny-all on the base table does NOT break the client's returns reads (the view bypasses base-table RLS as owner). CRITICAL FOLLOW-UP: if that view is ever switched to security_invoker=true, the authenticated role will need a SELECT policy here (USING(true)) or all client returns/YTD/charts break — treat the view's security_invoker=false as a load-bearing invariant. Separate residual exposure (out of scope of these two tables): the view itself is still readable by anon, so anon can indirectly read returns through strategy_returns_effective_c even after this DDL — consider REVOKE ALL ON public.strategy_returns_effective_c FROM anon (or move to a BFF endpoint) if anon-readable returns are unacceptable; that view is also flagged by Supabase security advisors precisely because security_invoker=false leaks owner privileges. No ownership column exists, so owner-scoping is impossible and deny-all is the correct minimal posture.
-- ------------------------------------------------------------
-- strategies_returns_c: raw daily strategy returns (no ownership/user_id column).
-- No direct client access. MINT reads returns only via view public.strategy_returns_effective_c,
-- which is security_invoker=false and therefore runs as the view owner (bypasses this table's RLS).
-- All direct access is WN service-role BFF (bypasses RLS).
ALTER TABLE public."strategies_returns_c" ENABLE ROW LEVEL SECURITY;

-- No policies: deny all direct anon/authenticated access. Service-role and the
-- security-definer view owner are unaffected. Strip existing grants for defense in depth.
REVOKE ALL ON public."strategies_returns_c" FROM anon, authenticated;

-- ============================================================
-- TABLE: News_articles  [reference_public_read]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: Category is reference_public_read but access is deliberately narrowed to the authenticated role (all three MINT read sites are behind app login; there is no logged-out/public news preview in these repos). If a truly unauthenticated (anon) news view is ever added, this authenticated-only SELECT would block it — flip the policy to `TO anon, authenticated` and re-GRANT SELECT to anon, which would re-open the anon read. populateNews.js INSERT/SELECT (window.populateNewsArticles) WILL be blocked after this change: no anon grant, and no INSERT policy for authenticated. This is intended and safe — it is a manual dev-console seed helper, NOT a production path; production wire ingest is server-side via createRetailServiceRoleClient (service_role bypasses RLS, retains GRANT ALL). No user_id/owner column exists, so owner-scoping is N/A; correct model for a shared Alliance-wire catalog is authenticated-read + service-role-write. VERIFY before apply: confirm no anon (logged-out) surface reads /News_articles directly with the anon key; confirm the app's news UI users are always in the authenticated role.
-- ------------------------------------------------------------
ALTER TABLE public."News_articles" ENABLE ROW LEVEL SECURITY;

-- Replace the (currently inert) public-read policy with an authenticated-only read.
DROP POLICY IF EXISTS "Allow public read access" ON public."News_articles";
CREATE POLICY news_articles_authenticated_read
  ON public."News_articles"
  FOR SELECT
  TO authenticated
  USING (true);

-- Table privileges currently flow via PUBLIC (named-role grants are empty but
-- has_table_privilege is true for anon/authenticated). REVOKE from PUBLIC first,
-- then re-grant explicitly. This is what actually closes the anon key.
REVOKE ALL ON public."News_articles" FROM PUBLIC;
REVOKE ALL ON public."News_articles" FROM anon;
GRANT SELECT ON public."News_articles" TO authenticated;
GRANT ALL    ON public."News_articles" TO service_role;

-- ============================================================
-- TABLE: user_email_preferences  [server_role_only]  confidence=high  breaks_client=false  closes_anon=true
-- CAVEATS: No client op exists in either repo, so enabling RLS with no policies breaks nothing that is present today. Because the table has NO user_id column, owner-scoping via `user_id = (select auth.uid())` is impossible; if a client-managed preference UI is ever added it must scope by email (e.g. email = (select auth.jwt()->>'email')) and would need its own owner policy — not addable now without that column/design. IMPORTANT design note: email unsubscribe links are typically clicked while LOGGED OUT (anon). Any such unsubscribe endpoint MUST run server-side (service_role / edge function), NOT the anon browser client — none exists in these repos, so this is safe, but if an unsubscribe handler is later wired to the anon key it will break under this lockdown; route it through the service-role BFF instead. VERIFY before apply: confirm the production unsubscribe/preferences writer is a server-side service_role path (edge function or BFF), and that no other Supabase project/client (outside these two repos) reads/writes this table with the anon key.
-- ------------------------------------------------------------
ALTER TABLE public.user_email_preferences ENABLE ROW LEVEL SECURITY;

-- No client policies: no client read/write path exists. RLS-enabled with zero
-- policies denies anon and authenticated entirely; service_role bypasses RLS.

-- Privileges currently flow via PUBLIC — revoke there, then grant only service_role.
REVOKE ALL ON public.user_email_preferences FROM PUBLIC;
REVOKE ALL ON public.user_email_preferences FROM anon;
REVOKE ALL ON public.user_email_preferences FROM authenticated;
GRANT ALL  ON public.user_email_preferences TO service_role;
