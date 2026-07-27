-- =============================================================================
-- RETAIL (mfxng) PERFORMANCE TUNING — measured against the live DB 2026-07-25
-- =============================================================================
-- Measured facts (not estimates):
--   stock_intraday_c   3,556,961 rows   763 MB
--   cc_audit_log         196,683 rows   742 MB   (~3.8 KB/row — JSONB snapshots)
--   stock_returns_c    1,149,505 rows   386 MB
--   backup_20260717_*  2 tables         200 kB   (negligible — NOT worth deleting data for)
--
-- Advisor lints that actually matter on this Micro instance (~99.7% CPU):
--   auth_rls_initplan            x59  ← re-evaluates auth.uid() PER ROW
--   multiple_permissive_policies x54  ← every policy evaluated on every query
-- Both land on the SAME hot per-user tables (user_onboarding, stock_holdings_c,
-- profiles, transactions, family_members), so their costs multiply.
--
-- Ordering: SECTION 1 is safe and immediate. SECTION 2 is the real CPU win but must
-- be reviewed per policy. SECTION 3/4 are capacity decisions.
-- =============================================================================


-- ###########################################################################
-- SECTION 1 — Drop duplicate indexes on family_members            [SAFE]
-- ###########################################################################
-- CONFIRMED: 4 identical pairs. Each INSERT/UPDATE currently maintains BOTH copies
-- (pure write amplification). Sizes are small (16 kB each) so this is a write-cost
-- fix, not a space fix. Keeping the idx_* names, dropping the *_idx duplicates.

DROP INDEX IF EXISTS public.family_members_linked_user_id_idx;   -- dup of idx_family_members_linked_user_id
DROP INDEX IF EXISTS public.family_members_primary_user_id_idx;  -- dup of idx_family_members_primary_user_id
DROP INDEX IF EXISTS public.family_members_relationship_idx;     -- dup of idx_family_members_relationship
DROP INDEX IF EXISTS public.family_members_spouse_email_idx;     -- dup of idx_family_members_spouse_email
-- NOTE: family_members_unique_spouse_per_user (partial UNIQUE) and family_members_pkey
-- are NOT duplicates — keep them.

-- VERIFY (expect 6 remaining: 4 idx_*, the pkey, and the partial unique):
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='family_members' ORDER BY indexname;


-- ###########################################################################
-- SECTION 2 — The actual CPU fix: RLS initplan               [REVIEW, HIGH VALUE]
-- ###########################################################################
-- An un-wrapped auth.uid() in a policy is re-evaluated FOR EVERY ROW. Wrapping it as
-- (SELECT auth.uid()) lets the planner hoist it to a one-time initplan. On a table
-- scanned with thousands of rows per request this is often a 10-100x reduction in
-- policy evaluation cost — the single biggest lever on the current CPU pressure.
--
-- DO NOT hand-edit 59 policies blind. Run this GENERATOR, read the output, then run
-- the statements it produces (spot-check a few first, then the hot tables).
-- It rewrites ONLY the auth.uid()/auth.jwt() call form; the predicate logic is
-- preserved verbatim, so semantics do not change.

SELECT format(
         'DROP POLICY %I ON public.%I; CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
         policyname, tablename, policyname, tablename,
         permissive,
         cmd,
         array_to_string(roles, ', '),
         CASE WHEN qual IS NOT NULL THEN ' USING (' ||
              regexp_replace(regexp_replace(qual, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g'),
                             '(?<!SELECT )auth\.jwt\(\)', '(SELECT auth.jwt())', 'g') || ')' ELSE '' END,
         CASE WHEN with_check IS NOT NULL THEN ' WITH CHECK (' ||
              regexp_replace(regexp_replace(with_check, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g'),
                             '(?<!SELECT )auth\.jwt\(\)', '(SELECT auth.jwt())', 'g') || ')' ELSE '' END
       ) AS rewrite_sql,
       tablename, policyname
FROM pg_policies
WHERE schemaname='public'
  AND (qual ~ 'auth\.(uid|jwt)\(\)' OR with_check ~ 'auth\.(uid|jwt)\(\)')
  AND NOT (coalesce(qual,'') ~ 'SELECT auth\.' OR coalesce(with_check,'') ~ 'SELECT auth\.')
ORDER BY (tablename IN ('user_onboarding','stock_holdings_c','profiles','transactions','family_members','notifications')) DESC,
         tablename, policyname;

-- ⚠️ Before running the generated output: each statement DROPs then re-CREATEs a
-- policy, so run them inside a transaction per table and smoke-test that table's
-- reads/writes afterwards. Keep the original definitions (this query's source rows)
-- so you can restore verbatim.
-- SNAPSHOT the originals first:
--   CREATE TABLE IF NOT EXISTS public._policy_backup_20260725 AS
--     SELECT * FROM pg_policies WHERE schemaname='public';

-- Companion lint (multiple_permissive_policies x54): list the role/action combos with
-- more than one PERMISSIVE policy. Consolidating these (OR the predicates into one
-- policy) removes repeated evaluation. Review before merging — overlapping policies
-- sometimes exist deliberately.
SELECT tablename, cmd, array_to_string(roles,', ') AS role_set, count(*) AS n_policies,
       string_agg(policyname, ' | ' ORDER BY policyname) AS policies
FROM pg_policies
WHERE schemaname='public' AND permissive='PERMISSIVE'
GROUP BY tablename, cmd, roles
HAVING count(*) > 1
ORDER BY count(*) DESC, tablename
LIMIT 40;


-- ###########################################################################
-- SECTION 3 — Retention: the two 700 MB+ tables            [DECISION NEEDED]
-- ###########################################################################
-- These dominate the instance. Neither should be truncated blindly — decide a policy.
--
-- (a) cc_audit_log — 742 MB from 196k rows. Written by cc_audit_trigger_fn() on 7
--     triggers. Rows are huge (JSONB before/after snapshots). It is a COMPLIANCE
--     artifact, so do NOT delete without a retention decision + an export.
--     Inspect the age distribution and per-table share first:
SELECT date_trunc('month', changed_at) AS month, count(*), pg_size_pretty(sum(pg_column_size(t.*))::bigint) AS approx_size
FROM public.cc_audit_log t
WHERE changed_at IS NOT NULL
GROUP BY 1 ORDER BY 1;
--     Then, if policy allows (EXPORT FIRST):
--     DELETE FROM public.cc_audit_log WHERE created_at < now() - interval '12 months';
--     Consider pg_cron monthly pruning + narrowing what the trigger snapshots.
--
-- (b) stock_intraday_c — 763 MB / 3.56M rows and growing every 2 min per security.
--     This is a PRICE TICK log; only the latest tick per security is read on hot paths
--     (plus a ~14-day window for charts, per the WN windowed read). Older ticks are
--     already summarised into stock_returns_c (daily EOD).
--     Check what a 90-day retention would reclaim BEFORE deleting:
SELECT count(*) AS rows_older_than_90d,
       pg_size_pretty((pg_total_relation_size('public.stock_intraday_c')
                       * count(*)::numeric / NULLIF((SELECT count(*) FROM public.stock_intraday_c),0))::bigint) AS approx_reclaim
FROM public.stock_intraday_c WHERE "timestamp" < now() - interval '90 days';
--     Then delete in BATCHES (never one statement — it will lock/bloat on Micro):
--     DELETE FROM public.stock_intraday_c
--      WHERE ctid IN (SELECT ctid FROM public.stock_intraday_c
--                     WHERE "timestamp" < now() - interval '90 days' LIMIT 50000);
--     Repeat until 0 rows affected, then: VACUUM (ANALYZE) public.stock_intraday_c;
--     (Plain DELETE does not return space to the OS — only VACUUM FULL/pg_repack does,
--      and VACUUM FULL takes an exclusive lock. Schedule it.)

-- Low priority: the leftover backup schemas are only ~200 kB combined. Drop them for
-- tidiness if you like, but they are NOT a performance factor:
--   DROP SCHEMA IF EXISTS backup_20260717_all_rich_details CASCADE;
--   DROP SCHEMA IF EXISTS backup_20260717_client_details   CASCADE;

-- Add the missing PK flagged on the rebalance residuals money table:
--   ALTER TABLE public.strategy_rebalance_residuals ADD COLUMN IF NOT EXISTS id bigserial;
--   ALTER TABLE public.strategy_rebalance_residuals ADD PRIMARY KEY (id);


-- ###########################################################################
-- SECTION 4 — Unindexed foreign keys                          [SAFE, ADDITIVE]
-- ###########################################################################
-- 36 retail tables have FK columns with no covering index → sequential scans on
-- joins and on every cascade check. Generate the exact CREATE INDEX statements
-- (uses CONCURRENTLY so it never blocks writes; run them one at a time, NOT inside
-- a transaction block):

SELECT format('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_%s_%s ON public.%I (%s);',
              c.relname, string_agg(a.attname, '_' ORDER BY x.ord),
              c.relname, string_agg(quote_ident(a.attname), ', ' ORDER BY x.ord)) AS create_sql
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
WHERE con.contype='f' AND n.nspname='public'
GROUP BY con.oid, c.relname
HAVING NOT EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indrelid = con.conrelid
    AND (i.indkey::smallint[])[0:array_length(con.conkey,1)-1] = con.conkey
)
ORDER BY c.relname;

-- Do NOT drop the ~45 "unused" indexes the advisor lists until you have observed a
-- full business cycle (month-end, EOD, rebalance) — and never drop one you just
-- created above to cover an FK.
