-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Strategies table — surfaces a single row per live strategy with the
-- headline KPIs the /oems/strategies page renders. The audit-grade
-- holdings / rebalance history live in `oems_position_c` and the IPS
-- order/audit mirror; this table is the *aggregate* view the desk cares
-- about day-to-day (AUM, day P&L, MTD P&L, status, asset class).
--
-- Today: v1 is seeded via manual SQL. The IRESS-side source of truth is
-- `IPSAccountGetAll1` (for the AUM aggregate) and a per-strategy
-- `strategy_definition_c` row in the firm's portfolio system. A future
-- worker loop will compute the per-strategy rollups from
-- `oems_position_c` and upsert them here. v1 is read-only.
--
-- Idempotent: CREATE TABLE / ADD COLUMN / CREATE INDEX IF NOT EXISTS.
-- No DROP / TRUNCATE / DELETE; the worker only INSERTs / upserts.

CREATE TABLE IF NOT EXISTS public.oems_strategy_c (
  strategy_id   TEXT         PRIMARY KEY,                       -- e.g. "STRAT-EQ-001"
  name          TEXT         NOT NULL,                          -- "SA Equity Core"
  status        TEXT         NOT NULL DEFAULT 'live',           -- live | paper | halted
  asset_class   TEXT         NOT NULL,                          -- equity | money_market | balanced | fixed_income
  manager       TEXT,                                            -- desk lead
  benchmark     TEXT,                                            -- e.g. "J203"
  aum_cents     NUMERIC      NOT NULL DEFAULT 0,                -- currency-native cents (ZAR × 100)
  pnl_today_cents NUMERIC    NOT NULL DEFAULT 0,                -- cents
  pnl_mtd_cents   NUMERIC    NOT NULL DEFAULT 0,                -- cents
  pnl_ytd_pct   NUMERIC      NOT NULL DEFAULT 0,                -- percentage points
  nav_value_cents NUMERIC    NOT NULL DEFAULT 0,                -- current NAV in cents
  investor_count INTEGER     NOT NULL DEFAULT 0,
  holdings_count INTEGER     NOT NULL DEFAULT 0,
  cash_weight_pct NUMERIC    NOT NULL DEFAULT 0,                -- 0..100
  deployed_at   TIMESTAMPTZ,                                    -- when status flipped to "live"
  last_rebalanced_at TIMESTAMPTZ,                                -- most recent rebalance
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- full upstream row
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT oems_strategy_c_status_chk
    CHECK (status IN ('live', 'paper', 'halted')),
  CONSTRAINT oems_strategy_c_asset_class_chk
    CHECK (asset_class IN ('equity', 'money_market', 'balanced', 'fixed_income'))
);

COMMENT ON TABLE public.oems_strategy_c IS
  'Per-strategy aggregate (AUM, day/mtd P&L, status, asset class). Powers the /oems/strategies page. v1 seeded manually or via a future worker rollup; service_role writes; RLS denies anon/auth.';

CREATE INDEX IF NOT EXISTS idx_oems_strategy_c_status
  ON public.oems_strategy_c (status);

CREATE INDEX IF NOT EXISTS idx_oems_strategy_c_asset_class
  ON public.oems_strategy_c (asset_class);

CREATE INDEX IF NOT EXISTS idx_oems_strategy_c_updated_at
  ON public.oems_strategy_c (updated_at DESC);

-- RLS: deny anon / authenticated (service_role bypasses)
ALTER TABLE public.oems_strategy_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny for anon/authenticated; service_role still has full access.
