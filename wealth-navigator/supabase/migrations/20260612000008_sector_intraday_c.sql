-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Tier 2 wiring: sector index intraday points (J200 / sector codes).
-- Powers the Cockpit sector heatmap when IRESS TimeSeriesGet2 is entitled
-- for the J200 code. One row per (sector_code, timestamp).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS only. No DROP / TRUNCATE / DELETE.

CREATE TABLE IF NOT EXISTS public.sector_intraday_c (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sector_code  TEXT         NOT NULL,
  sector_name  TEXT,
  value        NUMERIC      NOT NULL,
  change_pct   NUMERIC      NOT NULL DEFAULT 0,
  timestamp    TIMESTAMPTZ  NOT NULL,
  source       TEXT         NOT NULL DEFAULT 'iress-worker',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sector_intraday_c_code_ts
  ON public.sector_intraday_c (sector_code, timestamp DESC);

ALTER TABLE public.sector_intraday_c
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sector_intraday_c read" ON public.sector_intraday_c;
CREATE POLICY "sector_intraday_c read"
  ON public.sector_intraday_c
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "sector_intraday_c service write" ON public.sector_intraday_c;
CREATE POLICY "sector_intraday_c service write"
  ON public.sector_intraday_c
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.sector_intraday_c IS
  'Sector index intraday series points (J200 / sector codes) populated by the Railway iress-ingest worker via IRESS TimeSeriesGet2. Read-only for anon / authenticated.';
COMMENT ON COLUMN public.sector_intraday_c.sector_code IS
  'IRESS sector index code (e.g. J200 for JSE Resources, J201 for JSE Financials, etc.).';
