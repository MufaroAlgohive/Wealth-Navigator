-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Tier 2 wiring: ZAR sovereign yield-curve history. One row per (curve_id,
-- tenor, as_of) so the BFF can return a fitted curve in O(1) and the UI can
-- render the NSS line + per-bucket bars. Backed by IRESS
-- `TimeSeriesGet2` for the bond codes (R2030, R2035, R2040, ...) and the
-- worker loop in `workers/iress-ingest/src/timeseries.ts`.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS only.
-- No DROP / TRUNCATE / DELETE; the worker only INSERTs / upserts.

CREATE TABLE IF NOT EXISTS public.yield_curve_history_c (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  curve_id     TEXT         NOT NULL,
  tenor_label  TEXT         NOT NULL,
  tenor_years  NUMERIC      NOT NULL,
  yield_pct    NUMERIC      NOT NULL,
  as_of        TIMESTAMPTZ  NOT NULL,
  source       TEXT         NOT NULL DEFAULT 'iress-worker',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_yield_curve_history_c_curve_as_of
  ON public.yield_curve_history_c (curve_id, as_of DESC);

ALTER TABLE public.yield_curve_history_c
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "yield_curve_history_c read" ON public.yield_curve_history_c;
CREATE POLICY "yield_curve_history_c read"
  ON public.yield_curve_history_c
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "yield_curve_history_c service write" ON public.yield_curve_history_c;
CREATE POLICY "yield_curve_history_c service write"
  ON public.yield_curve_history_c
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.yield_curve_history_c IS
  'Fitted yield-curve points (tenor, yield). One row per (curve_id, tenor, as_of). Populated by the Railway iress-ingest worker via IRESS TimeSeriesGet2. Read-only for anon / authenticated.';
COMMENT ON COLUMN public.yield_curve_history_c.curve_id IS
  'IRESS reference-data code (e.g. "ZAR_NSS" for the NSS-fitted sovereign curve, "R2030" for the R2030 bond).';
COMMENT ON COLUMN public.yield_curve_history_c.tenor_years IS
  'Tenor in years (numeric, supports sub-annual tenors like 0.25, 0.5).';
COMMENT ON COLUMN public.yield_curve_history_c.yield_pct IS
  'Par yield in percent (e.g. 11.42 means 11.42%). NOT in cents.';
