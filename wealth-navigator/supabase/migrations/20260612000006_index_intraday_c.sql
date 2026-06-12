-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Tier 2 wiring: intraday series for JSE indices (J203 ALSI, sector codes
-- J200, etc.). Backed by IRESS `TimeSeriesGet2` and the worker loop in
-- `workers/iress-ingest/src/timeseries.ts` (when Charles enables the
-- entitlement). One row per (index_code, timestamp) so the UI can render
-- the canonical "in progress since 09:00" chart.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS only.
-- No DROP / TRUNCATE / DELETE; the worker only INSERTs.

CREATE TABLE IF NOT EXISTS public.index_intraday_c (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  index_code   TEXT         NOT NULL,
  exchange     TEXT         NOT NULL DEFAULT 'JSE',
  value        NUMERIC      NOT NULL,
  timestamp    TIMESTAMPTZ  NOT NULL,
  source       TEXT         NOT NULL DEFAULT 'iress-worker',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_index_intraday_c_code_ts
  ON public.index_intraday_c (index_code, timestamp DESC);

ALTER TABLE public.index_intraday_c
  ENABLE ROW LEVEL SECURITY;

-- Read-only policy: same shape as `stock_intraday_c` (anon + authenticated
-- can SELECT; service role writes via worker).
DROP POLICY IF EXISTS "index_intraday_c read" ON public.index_intraday_c;
CREATE POLICY "index_intraday_c read"
  ON public.index_intraday_c
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Service role bypasses RLS; the policy is here for defence in depth.
DROP POLICY IF EXISTS "index_intraday_c service write" ON public.index_intraday_c;
CREATE POLICY "index_intraday_c service write"
  ON public.index_intraday_c
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.index_intraday_c IS
  'Intraday index series points (J203 ALSI, J200 sector indices, etc.) populated by the Railway iress-ingest worker via IRESS TimeSeriesGet2. Read-only for anon / authenticated.';
COMMENT ON COLUMN public.index_intraday_c.index_code IS
  'IRESS TimeSeriesGet2 Code (e.g. J203 for ALSI, sector codes for J200 constituents).';
COMMENT ON COLUMN public.index_intraday_c.source IS
  'Provenance tag. iress-worker when populated by the worker; mock when the seed loader writes; live when fetched directly from IRESS by a path B route.';
