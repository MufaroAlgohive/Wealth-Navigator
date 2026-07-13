-- model_*_c : quant-model tracking (Docker to Supabase to website).
-- Local model containers (e.g. Qentari_Bravo_JSE, Lumibot/DuckDB, Yahoo-fed
-- paper/sim) push their registry, metrics, equity curve, predictions, positions,
-- trades and heartbeat here; the OEMS "Models" tab reads it alongside the
-- IRESS/Yahoo market data. INSTITUTIONAL DB (nnwz). Service-role only (writes
-- from the pusher, reads via the BFF). Idempotent; safe to re-run.

-- ── registry: one row per model ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_registry_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,                    -- 'qentari_bravo_jse'
  name TEXT NOT NULL,
  description TEXT,
  strategy_name TEXT,
  version TEXT DEFAULT '1.0.0',
  market TEXT,                                  -- 'jse'
  universe TEXT,
  data_source TEXT DEFAULT 'yahoo',            -- feed the model paper-trades on
  currency TEXT DEFAULT 'ZAR',
  budget DOUBLE PRECISION,
  ml_enabled BOOLEAN DEFAULT TRUE,
  ml_threshold DOUBLE PRECISION,
  ml_model_path TEXT,
  max_positions INTEGER,
  rebalance_days INTEGER,
  cadence TEXT,                                 -- 'daily 08:30 SAST'
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','backtest','live')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','paper','live','error','stopped')),
  is_active BOOLEAN DEFAULT TRUE,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,    -- strategy knobs (lookback, target_vol, ...)
  last_heartbeat_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── metric snapshots: backtest + live rollups (headline stats) ──────────────
CREATE TABLE IF NOT EXISTS model_metric_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_slug TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'backtest' CHECK (kind IN ('backtest','live','paper','subperiod')),
  label TEXT NOT NULL DEFAULT 'default',        -- run name, e.g. 'mint_alpha_realfund'
  as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  start_date DATE,
  end_date DATE,
  budget DOUBLE PRECISION,
  final_equity DOUBLE PRECISION,
  total_return DOUBLE PRECISION,
  cagr DOUBLE PRECISION,
  sharpe DOUBLE PRECISION,
  sortino DOUBLE PRECISION,
  volatility DOUBLE PRECISION,
  max_drawdown DOUBLE PRECISION,
  romad DOUBLE PRECISION,
  win_rate DOUBLE PRECISION,
  n_trades INTEGER,
  n_round_trips INTEGER,
  total_pnl DOUBLE PRECISION,
  avg_pnl_per_trade DOUBLE PRECISION,
  benchmark_cagr DOUBLE PRECISION,
  alpha_cagr DOUBLE PRECISION,
  fees_bps DOUBLE PRECISION,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,      -- every other stats.json field
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_slug, kind, label)
);

-- ── equity curve points (backtest + live) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS model_equity_point_c (
  model_slug TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'backtest' CHECK (kind IN ('backtest','live','paper','subperiod')),
  label TEXT NOT NULL DEFAULT 'default',
  ts TIMESTAMPTZ NOT NULL,
  equity DOUBLE PRECISION,
  ret DOUBLE PRECISION,
  cash DOUBLE PRECISION,
  day_pnl DOUBLE PRECISION,
  day_pnl_pct DOUBLE PRECISION,
  PRIMARY KEY (model_slug, kind, label, ts)
);

-- ── predictions / signals with reasoning ───────────────────────────────────
CREATE TABLE IF NOT EXISTS model_prediction_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_slug TEXT NOT NULL,
  predicted_at TIMESTAMPTZ NOT NULL,
  strategy_name TEXT,
  symbol TEXT NOT NULL,
  side TEXT,
  quantity DOUBLE PRECISION,
  expected_entry_price DOUBLE PRECISION,
  ml_prob_up DOUBLE PRECISION,
  ml_threshold DOUBLE PRECISION,
  score DOUBLE PRECISION,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_slug, predicted_at, symbol)
);

-- ── position snapshots (history; UI shows the latest snapshot_at) ───────────
CREATE TABLE IF NOT EXISTS model_position_c (
  model_slug TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  symbol TEXT NOT NULL,
  qty DOUBLE PRECISION,
  market_value DOUBLE PRECISION,
  avg_entry_price DOUBLE PRECISION,
  unrealized_pl DOUBLE PRECISION,
  unrealized_plpc DOUBLE PRECISION,
  weight DOUBLE PRECISION,
  side TEXT,
  PRIMARY KEY (model_slug, snapshot_at, symbol)
);

-- ── trade ledger (live round-trips + backtest fills) ───────────────────────
CREATE TABLE IF NOT EXISTS model_trade_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_slug TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'live' CHECK (kind IN ('live','backtest','paper')),
  label TEXT NOT NULL DEFAULT 'default',
  trade_id TEXT NOT NULL,                        -- source id or deterministic hash
  symbol TEXT NOT NULL,
  side TEXT,
  qty DOUBLE PRECISION,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  price DOUBLE PRECISION,                        -- single-leg (backtest) fill price
  entry_at TIMESTAMPTZ,
  exit_at TIMESTAMPTZ,
  trade_date DATE,
  realized_pnl DOUBLE PRECISION,
  pnl DOUBLE PRECISION,
  fees_bps DOUBLE PRECISION,
  fees DOUBLE PRECISION,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_slug, kind, label, trade_id)
);

-- ── run / heartbeat log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_run_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_slug TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'push' CHECK (kind IN ('live','backtest','heartbeat','push')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('started','ok','error')),
  message TEXT,
  rows_pushed INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_model_metric_slug ON model_metric_c(model_slug, kind);
CREATE INDEX IF NOT EXISTS idx_model_equity_slug ON model_equity_point_c(model_slug, kind, ts);
CREATE INDEX IF NOT EXISTS idx_model_pred_slug ON model_prediction_c(model_slug, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_pos_slug ON model_position_c(model_slug, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_trade_slug ON model_trade_c(model_slug, kind, exit_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_run_slug ON model_run_c(model_slug, created_at DESC);

-- ── RLS: service-role only (pusher writes, BFF reads) ───────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'model_registry_c','model_metric_c','model_equity_point_c',
    'model_prediction_c','model_position_c','model_trade_c','model_run_c'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_service_role', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t || '_service_role', t
    );
  END LOOP;
END $$;
