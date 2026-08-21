-- REVIEW BEFORE APPLY — RETAIL project mfxnghmuccevsxwcetej
--
-- Persisted cache for /api/equities' Yahoo-derived 1M/6M trailing returns
-- (src/app/api/equities/route.ts, attachPeriodReturns). PR #159 introduced a
-- rotating in-process cache to stop re-fetching the same fixed top-60 names
-- every request, but that cache — and its rotation cursor — lived in the
-- serverless function's process memory. On Vercel that memory does not
-- survive a cold start, and concurrent requests can land on separate
-- instances that never share it, so in production the "rotation" kept
-- restarting at the same ~56 names instead of progressing (confirmed live:
-- 56/376 coverage, unchanged across repeated page loads).
--
-- This table makes the cache — and therefore the rotation — survive across
-- function instances: `computed_at` orders the rotation ("fetch whichever
-- symbols are stalest") with no separate cursor needed, and is naturally
-- resistant to cold starts, redeploys, and concurrent instances.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.equities_period_returns_cache_c (
  symbol text PRIMARY KEY,           -- bare JSE code, e.g. "EXX" (no .JO suffix)
  return_1m numeric,
  return_6m numeric,
  bars_as_of timestamptz,            -- latest Yahoo daily close used for the computation
  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.equities_period_returns_cache_c IS
  'Persisted rotation cache for /api/equities trailing 1M/6M returns (Yahoo-derived, best-effort). computed_at drives the rotation: the route refreshes whichever symbols are oldest on each request instead of a fixed top-N.';

-- Service role bypasses RLS; anon/authenticated should not read/write this
-- directly — the route reads it via the RETAIL service-role client, same as
-- securities_c itself.
ALTER TABLE public.equities_period_returns_cache_c ENABLE ROW LEVEL SECURITY;

-- No policies = deny for anon/authenticated; service_role still has full access.

CREATE INDEX IF NOT EXISTS equities_period_returns_cache_c_computed_at_idx
  ON public.equities_period_returns_cache_c (computed_at ASC);
