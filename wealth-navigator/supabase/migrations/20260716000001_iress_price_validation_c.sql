-- iress_price_validation_c — per-symbol Yahoo-vs-IRESS(PROD) accuracy scoreboard.
--
-- The dual-seat window (PROD market data + UAT orders) lets us shadow-compare
-- the paid IRESS PROD feed against the free Yahoo reference PER SYMBOL, OVER
-- TIME, before switching any symbol off Yahoo. This table is the durable record
-- that drives a conditional, per-symbol cutover: a symbol is only a cutover
-- candidate once IRESS has tracked Yahoo within tolerance for a stable streak
-- of samples (not a single lucky tick), and a human has `approved` it.
--
-- Institutional (nnwz). Read-only w.r.t. the money tables — this NEVER writes
-- securities_c / stock_intraday_c. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS iress_price_validation_c (
  symbol            text PRIMARY KEY,            -- bare JSE code, e.g. 'AGL'
  last_iress_cents  numeric,                     -- most recent IRESS PROD price (cents)
  last_yahoo_cents  numeric,                     -- most recent Yahoo reference (cents)
  last_divergence_pct numeric,                   -- |iress-yahoo|/yahoo * 100
  last_severity     text,                        -- ok | watch | breach | no-data
  samples_total     integer NOT NULL DEFAULT 0,  -- comparisons recorded
  samples_ok        integer NOT NULL DEFAULT 0,  -- comparisons within tolerance
  consecutive_ok    integer NOT NULL DEFAULT 0,  -- current in-tolerance streak
  max_consecutive_ok integer NOT NULL DEFAULT 0, -- best streak achieved
  covered           boolean NOT NULL DEFAULT false, -- IRESS priced it on the last sample
  validated         boolean NOT NULL DEFAULT false, -- AUTO verdict: stable streak reached
  validated_at      timestamptz,                 -- when the auto verdict first flipped true
  approved          boolean NOT NULL DEFAULT false, -- MANUAL human approval to cut this symbol over
  approved_by       text,
  approved_at       timestamptz,
  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_checked      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iress_validation_validated ON iress_price_validation_c(validated);
CREATE INDEX IF NOT EXISTS idx_iress_validation_approved ON iress_price_validation_c(approved);

ALTER TABLE iress_price_validation_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iress_price_validation_service_role ON iress_price_validation_c;
CREATE POLICY iress_price_validation_service_role ON iress_price_validation_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
