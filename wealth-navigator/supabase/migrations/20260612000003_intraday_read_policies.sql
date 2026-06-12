-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- Read-only RLS policies for the UI hot path:
--   anon / authenticated can SELECT from stock_intraday_c and securities_c
--   writes remain service_role only (the worker keeps using service_role).
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY pattern.
-- No DROP / TRUNCATE / DELETE on tables; policies only.

ALTER TABLE public.stock_intraday_c ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.securities_c    ENABLE ROW LEVEL SECURITY;

-- Re-run-safe: drop any prior copy of these policies first.
DROP POLICY IF EXISTS "anon read stock_intraday_c"   ON public.stock_intraday_c;
DROP POLICY IF EXISTS "auth read stock_intraday_c"   ON public.stock_intraday_c;
DROP POLICY IF EXISTS "anon read securities_c"       ON public.securities_c;
DROP POLICY IF EXISTS "auth read securities_c"       ON public.securities_c;

CREATE POLICY "anon read stock_intraday_c"
  ON public.stock_intraday_c
  FOR SELECT TO anon USING (true);

CREATE POLICY "auth read stock_intraday_c"
  ON public.stock_intraday_c
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "anon read securities_c"
  ON public.securities_c
  FOR SELECT TO anon USING (true);

CREATE POLICY "auth read securities_c"
  ON public.securities_c
  FOR SELECT TO authenticated USING (true);

-- No INSERT / UPDATE / DELETE policies are created — only service_role (the worker)
-- can write. anon / authenticated see quotes / instrument metadata, never modify them.
