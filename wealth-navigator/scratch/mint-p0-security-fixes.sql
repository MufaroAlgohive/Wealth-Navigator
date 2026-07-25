-- =============================================================================
-- P0 SECURITY FIXES — verified against live DBs on 2026-07-25
-- =============================================================================
-- Every item below was CONFIRMED by querying the live databases (not inferred):
--   * has_function_privilege('anon', ...) = true on 9 SECURITY DEFINER functions
--   * oems_order_book (INSTITUTIONAL): relrowsecurity = false, anon SELECT+INSERT = true, 0 policies
--   * investor_trade_confirmations: two "Admin" policies that are actually USING (true) for ALL authenticated
--   * strategy_returns_effective_c / _latest_c: reloptions = security_invoker=false (explicitly DEFINER)
--
-- Dependency checks already performed (this is why the REVOKEs below are asymmetric):
--   * NONE of the 7 non-trigger functions are called anywhere in MINT/WN app code (no supabase.rpc()).
--   * cc_audit_trigger_fn() backs 7 triggers, handle_new_user() backs 1 — triggers are invoked
--     INTERNALLY by Postgres, so revoking API EXECUTE does NOT affect them.
--   * is_crm_admin() IS referenced inside two RLS policies (family_members_admin_read,
--     family_transactions_admin_read) for the `authenticated` role → we revoke it from `anon` ONLY.
--     Revoking it from `authenticated` WOULD BREAK those policies (permission denied).
--
-- RUN SECTIONS 1-2 FIRST (safe, no client-visible behaviour change).
-- SECTION 4 CHANGES READ SEMANTICS — test it before/after (instructions inline).
-- =============================================================================


-- ###########################################################################
-- SECTION 1 — RETAIL (mfxng): stop `anon` executing money functions   [SAFE]
-- ###########################################################################
-- Rationale: an unauthenticated caller holding the shipped browser anon key could
-- invoke money-movement functions directly. Nothing in the app calls these, so
-- revoking is a pure attack-surface removal.

REVOKE EXECUTE ON FUNCTION public.transfer_parent_to_child_wallet(uuid,uuid,bigint,text)                                      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_rebalance_reserve_charge(uuid,uuid,uuid,uuid,bigint,timestamptz,jsonb)                FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_strategy_rebalance_cash_event(uuid,uuid,uuid,uuid,text,bigint,timestamptz,jsonb)      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.secure_pledge_liquidity_v1(uuid,numeric,integer,integer,date,numeric,jsonb)                 FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.secure_pledge_liquidity_v1(uuid,numeric,integer,integer,date,numeric,numeric,jsonb)         FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_family_net_worth(uuid)                                                            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_isolated_portfolio_history(uuid,uuid)                                                   FROM anon, authenticated;

-- Trigger-only functions: never legitimately called through the API.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_audit_trigger_fn()  FROM anon, authenticated;

-- is_crm_admin(): anon ONLY. `authenticated` MUST keep EXECUTE — two RLS policies call it.
REVOKE EXECUTE ON FUNCTION public.is_crm_admin() FROM anon;

-- Harden search_path on the SECURITY DEFINER money functions (advisor: function_search_path_mutable).
-- A mutable search_path lets a caller shadow a table/function name and hijack a DEFINER function.
ALTER FUNCTION public.transfer_parent_to_child_wallet(uuid,uuid,bigint,text)                                   SET search_path = public, pg_temp;
ALTER FUNCTION public.apply_rebalance_reserve_charge(uuid,uuid,uuid,uuid,bigint,timestamptz,jsonb)             SET search_path = public, pg_temp;
ALTER FUNCTION public.apply_strategy_rebalance_cash_event(uuid,uuid,uuid,uuid,text,bigint,timestamptz,jsonb)   SET search_path = public, pg_temp;
ALTER FUNCTION public.secure_pledge_liquidity_v1(uuid,numeric,integer,integer,date,numeric,numeric,jsonb)      SET search_path = public, pg_temp;
ALTER FUNCTION public.calculate_family_net_worth(uuid)                                                         SET search_path = public, pg_temp;
ALTER FUNCTION public.get_isolated_portfolio_history(uuid,uuid)                                                SET search_path = public, pg_temp;
ALTER FUNCTION public.is_crm_admin()                                                                           SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user()                                                                        SET search_path = public, pg_temp;

-- VERIFY (expect anon_exec = false on every row; is_crm_admin keeps auth_exec = true):
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
 ('transfer_parent_to_child_wallet','secure_pledge_liquidity_v1','apply_rebalance_reserve_charge',
  'apply_strategy_rebalance_cash_event','calculate_family_net_worth','get_isolated_portfolio_history',
  'handle_new_user','is_crm_admin','cc_audit_trigger_fn')
ORDER BY p.proname;


-- ###########################################################################
-- SECTION 2 — RETAIL: investor_trade_confirmations really admin-only   [SAFE*]
-- ###########################################################################
-- Both existing policies are named "Admin ..." but are USING (true) for the
-- `authenticated` role, so EVERY logged-in user can read and write all trade
-- confirmations (money records). Replace with a real admin check.
-- *If your admin model is NOT is_crm_admin(), swap that predicate before running.

DROP POLICY IF EXISTS "Admin can read investor_trade_confirmations"  ON public.investor_trade_confirmations;
DROP POLICY IF EXISTS "Admin can write investor_trade_confirmations" ON public.investor_trade_confirmations;

CREATE POLICY "admin_read_investor_trade_confirmations" ON public.investor_trade_confirmations
  FOR SELECT TO authenticated USING (public.is_crm_admin());

CREATE POLICY "admin_write_investor_trade_confirmations" ON public.investor_trade_confirmations
  FOR ALL TO authenticated USING (public.is_crm_admin()) WITH CHECK (public.is_crm_admin());

REVOKE ALL ON public.investor_trade_confirmations FROM anon;

-- VERIFY (expect anon_sel = false):
SELECT has_table_privilege('anon','public.investor_trade_confirmations','SELECT') AS anon_sel;
-- Then SMOKE TEST: an admin user must still see/write trade confirmations; a normal
-- logged-in user must now see 0 rows.


-- ###########################################################################
-- SECTION 3 — INSTITUTIONAL (nnwz): lock down oems_order_book        [SAFE]
-- ###########################################################################
-- >>> RUN THIS ON THE INSTITUTIONAL PROJECT (nnwzhxfjpjbzujevwzlh), NOT RETAIL <<<
-- CONFIRMED: RLS is OFF, zero policies, and `anon` holds SELECT *and* INSERT on the
-- live OEMS order book — every client's trade orders are readable (and insertable)
-- by anyone with the publishable key. WN reads oems_* with the service-role key,
-- which BYPASSES RLS, so enabling RLS does not affect the app.

ALTER TABLE public.oems_order_book ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.oems_order_book FROM anon, authenticated;
-- No policy is created: service_role bypasses RLS, so the desk/BFF keeps working
-- while anon/authenticated are denied by default. Add a scoped policy later only if
-- a browser client legitimately needs direct access.

-- VERIFY (expect rls = true, anon_sel = false):
SELECT c.relrowsecurity AS rls,
       has_table_privilege('anon','public.oems_order_book','SELECT')  AS anon_sel,
       has_table_privilege('anon','public.oems_order_book','INSERT')  AS anon_ins
FROM pg_class c WHERE c.relname='oems_order_book' AND c.relnamespace='public'::regnamespace;


-- ###########################################################################
-- SECTION 4 — SECURITY DEFINER views → security_invoker   [⚠ TEST FIRST]
-- ###########################################################################
-- These views currently run with the CREATOR's privileges and bypass the caller's
-- RLS. They serve client-facing return/performance numbers.
--
-- ⚠️ WHY THIS NEEDS TESTING, NOT A BLIND RUN: with security_invoker=on the view
-- honours the CALLER's RLS. If an underlying table (strategies_returns_c, etc.)
-- has RLS enabled without a SELECT policy for `authenticated`, the view will
-- silently return ZERO ROWS and strategy returns/performance will VANISH from the
-- app. Run these ONE AT A TIME and check the app after each, or run on a preview
-- branch first. Instant rollback is included below.
--
-- Note: client_strategy_returns_effective_c / _latest_c are ALREADY security_invoker=on,
-- so this pattern is known to work for that pair — a good sign, but still verify.

-- ALTER VIEW public.strategy_returns_effective_c        SET (security_invoker = on);
-- ALTER VIEW public.strategy_returns_effective_latest_c SET (security_invoker = on);
-- ALTER VIEW public.daily_top_strategy                  SET (security_invoker = on);
-- ALTER VIEW public.cc_trigger_status                   SET (security_invoker = on);

-- On INSTITUTIONAL (nnwz), same caution:
-- ALTER VIEW public.securities_with_latest_quote SET (security_invoker = on);

-- PRE-CHECK — do the underlying tables allow `authenticated` to SELECT? If any row
-- shows rls=true with 0 policies, fix that BEFORE flipping the view.
SELECT c.relname, c.relrowsecurity AS rls,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies,
       has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT') AS auth_sel
FROM pg_class c
WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
  AND c.relname IN ('strategies_returns_c','strategies_c','client_strategy_returns_c')
ORDER BY c.relname;

-- VERIFY after flipping (expect security_invoker=on), then RELOAD THE APP and confirm
-- strategy returns still render:
--   SELECT relname, reloptions FROM pg_class
--    WHERE relnamespace='public'::regnamespace AND relkind='v'
--      AND relname LIKE 'strategy_returns_effective%';
-- ROLLBACK (instant, per view):
--   ALTER VIEW public.strategy_returns_effective_c SET (security_invoker = false);


-- ###########################################################################
-- SECTION 5 — Auth settings (do in the Dashboard, not SQL)
-- ###########################################################################
-- BOTH projects → Authentication → Providers/Policies:
--   * Enable "Leaked password protection" (HaveIBeenPwned). Currently DISABLED on
--     both, so users can set known-compromised passwords on financial accounts.
--   * Auth is capped at an ABSOLUTE 10 DB connections on both projects. Switch to a
--     percentage-based allocation BEFORE upsizing compute, or Auth won't scale with
--     the bigger instance and becomes the new bottleneck.
