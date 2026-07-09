-- strategy_daily_return_c — per-strategy daily return snapshots for the
-- Strategies dashboard (B2) and the Rebalance Builder affected-investor
-- preview. Backfills the gap between the long-horizon
-- `client_strategy_returns_c` snapshots and the IC's need to reason about
-- day-to-day NAV deltas.
--
-- Mint OEM Finalisation Phase B. Review-only; paste into the institutional
-- Supabase SQL editor. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS strategy_daily_return_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id TEXT NOT NULL,
  as_of_date DATE NOT NULL,
  daily_return_pct NUMERIC(10, 6),
  nav_cents BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_strategy_daily_return_strategy
  ON strategy_daily_return_c (strategy_id);

CREATE INDEX IF NOT EXISTS idx_strategy_daily_return_date
  ON strategy_daily_return_c (as_of_date DESC);

ALTER TABLE strategy_daily_return_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS strategy_daily_return_service_role ON strategy_daily_return_c;
CREATE POLICY strategy_daily_return_service_role ON strategy_daily_return_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);