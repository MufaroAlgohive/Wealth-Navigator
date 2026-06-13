-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Tier 2 wiring: per-curve derived metrics (OIS-spread, carry, rolldown,
-- PCA factors). The worker's `timeseries.ts` loop reads fitted curve
-- snapshots from `yield_curve_history_c` and writes one row per
-- (curve_id, metric, as_of) here. v1 is empty — the Cockpit's PCA
-- panel renders UNCONFIGURED until a curve is ingested.
--
-- Why a separate table? The fitted curve points live in
-- `yield_curve_history_c` (one row per tenor). The derived metrics are
-- a *scalar* per curve per day (OIS-spread @ 5Y, carry @ 5Y for 3M and
-- 12M, level / slope / curvature / residual bp). Storing them in a
-- separate table keeps the curves read query O(tenors) and the metrics
-- read query O(1) per day, and lets the PCA/carry UI read from a
-- narrow table without a window function.
--
-- Idempotent: CREATE TABLE / ADD COLUMN / CREATE INDEX IF NOT EXISTS.
-- No DROP / TRUNCATE / DELETE; the worker only INSERTs / upserts.

CREATE TABLE IF NOT EXISTS public.oems_curve_metric_c (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  curve_id     TEXT         NOT NULL,                          -- e.g. "ZAR_NSS", "ZAR_GOVI"
  metric       TEXT         NOT NULL,                          -- "ois_spread_3m" | "ois_spread_12m" | "carry_3m" | "rolldown_3m" | "carry_12m" | "rolldown_12m" | "pca_level" | "pca_slope" | "pca_curvature" | "pca_residual"
  tenor_label  TEXT,                                            -- tenor the metric refers to (e.g. "5Y"); null for PCA factors
  value        NUMERIC      NOT NULL,                          -- signed numeric; bp for PCA, % for spread/carry
  as_of        TIMESTAMPTZ  NOT NULL,
  source       TEXT         NOT NULL DEFAULT 'iress-worker',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (curve_id, metric, tenor_label, as_of)
);

COMMENT ON TABLE public.oems_curve_metric_c IS
  'Per-curve derived metrics (OIS-spread, carry, rolldown, PCA factors). Written by the Railway iress-ingest worker when a fitted curve snapshot is available; v1 is empty so the Cockpit/curves pages render UNCONFIGURED.';

CREATE INDEX IF NOT EXISTS idx_oems_curve_metric_c_curve_as_of
  ON public.oems_curve_metric_c (curve_id, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_oems_curve_metric_c_metric
  ON public.oems_curve_metric_c (metric);

ALTER TABLE public.oems_curve_metric_c ENABLE ROW LEVEL SECURITY;

-- Read policy: anon + authenticated can SELECT (mirrors yield_curve_history_c).
DROP POLICY IF EXISTS "oems_curve_metric_c read" ON public.oems_curve_metric_c;
CREATE POLICY "oems_curve_metric_c read"
  ON public.oems_curve_metric_c
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Service role can write.
DROP POLICY IF EXISTS "oems_curve_metric_c service write" ON public.oems_curve_metric_c;
CREATE POLICY "oems_curve_metric_c service write"
  ON public.oems_curve_metric_c
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
