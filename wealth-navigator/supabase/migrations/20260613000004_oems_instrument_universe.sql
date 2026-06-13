-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Tier 5 / Tier 6 wiring: empty shells for the bond, money-market, JIBAR
-- fixing, macro indicator, and news tables. The pages
--   /oems/fixed-income   (bonds_c)
--   /oems/money-market   (jibar_fixing_c, money_market_instrument_c)
--   /oems/macro          (macro_indicator_c, macro_release_c)
--   /oems/news           (news_item_c)
-- will read from these tables when populated. Today the worker does not
-- write to any of them (no vendor contract in place), so the BFF
-- responses return `source: "unavailable"` and the UI renders the
-- honest "External vendor / IRESS entitlement required" empty state.
--
-- We create the tables *now* so the BFF routes and UI components can be
-- wired in this same change set without a follow-up migration. The
-- worker (or a future cron) will upsert rows when a vendor is on-boarded
-- or an IRESS entitlement flips on.
--
-- Idempotent: CREATE TABLE / ADD COLUMN / CREATE INDEX IF NOT EXISTS.
-- No DROP / TRUNCATE / DELETE.

-- ─── bonds_c — ZAR fixed-income universe ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.bonds_c (
  isin          TEXT         PRIMARY KEY,
  bond_code     TEXT         NOT NULL,                          -- IRESS R-code or ISIN
  name          TEXT         NOT NULL,
  issuer        TEXT         NOT NULL,
  coupon_pct    NUMERIC      NOT NULL DEFAULT 0,
  maturity_date DATE,
  ytm_pct       NUMERIC,                                        -- yield-to-maturity in percent
  clean_price   NUMERIC,                                        -- currency-native
  dirty_price   NUMERIC,
  mod_duration  NUMERIC,
  dv01_cents    NUMERIC,                                        -- DV01 in cents
  convexity     NUMERIC,
  spread_bp     NUMERIC,                                        -- spread to govi curve in bp
  rating        TEXT,                                            -- e.g. "AA", "BBB+"
  liquidity     TEXT,                                            -- "high" | "medium" | "low"
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bonds_c IS
  'ZAR fixed-income universe. v1 empty (no IRESS bond entitlement on production); service_role writes.';

CREATE INDEX IF NOT EXISTS idx_bonds_c_issuer
  ON public.bonds_c (issuer);

CREATE INDEX IF NOT EXISTS idx_bonds_c_maturity
  ON public.bonds_c (maturity_date);

ALTER TABLE public.bonds_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny anon/auth; service_role bypasses RLS.

-- ─── money_market_instrument_c — NCD / T-Bill / FRN universe ─────────
CREATE TABLE IF NOT EXISTS public.money_market_instrument_c (
  ticker        TEXT         PRIMARY KEY,
  name          TEXT         NOT NULL,
  instrument_type TEXT       NOT NULL,                          -- "ncd" | "tbill" | "frn" | "reponame"
  issuer        TEXT         NOT NULL,
  tenor_label   TEXT         NOT NULL,                          -- e.g. "3M", "12M"
  yield_pct     NUMERIC      NOT NULL,
  duration_years NUMERIC     NOT NULL DEFAULT 0,
  rating        TEXT,
  notional_cents NUMERIC,                                        -- cents
  maturity_date DATE,
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.money_market_instrument_c IS
  'Eligible ZAR money-market instruments. v1 empty (no IRESS rate entitlement on production); service_role writes.';

CREATE INDEX IF NOT EXISTS idx_money_market_instrument_c_type
  ON public.money_market_instrument_c (instrument_type);

ALTER TABLE public.money_market_instrument_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny anon/auth; service_role bypasses RLS.

-- ─── jibar_fixing_c — SARB daily fixings ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.jibar_fixing_c (
  tenor         TEXT         NOT NULL,                          -- "3M" | "6M" | "12M"
  rate_date     DATE         NOT NULL,
  rate_pct      NUMERIC      NOT NULL,
  prev_rate_pct NUMERIC,
  change_bp     NUMERIC,                                        -- change vs prior fixing in basis points
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenor, rate_date)
);

COMMENT ON TABLE public.jibar_fixing_c IS
  'SARB JIBAR daily fixings per tenor. v1 empty; service_role writes; future worker will upsert from IRESS.';

CREATE INDEX IF NOT EXISTS idx_jibar_fixing_c_date
  ON public.jibar_fixing_c (rate_date DESC);

ALTER TABLE public.jibar_fixing_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny anon/auth; service_role bypasses RLS.

-- ─── macro_indicator_c — SARB / StatsSA / G10 series ──────────────────
CREATE TABLE IF NOT EXISTS public.macro_indicator_c (
  indicator_id  TEXT         NOT NULL,                          -- e.g. "ZA.CPI.YOY", "ZA.REPO"
  name          TEXT         NOT NULL,
  country       TEXT         NOT NULL,
  unit          TEXT,                                            -- "%" | "bp" | "index"
  value         NUMERIC      NOT NULL,
  prior_value   NUMERIC,
  as_of         TIMESTAMPTZ  NOT NULL,
  source        TEXT         NOT NULL DEFAULT 'iress-worker',   -- iress-worker | vendor | manual
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (indicator_id, as_of)
);

COMMENT ON TABLE public.macro_indicator_c IS
  'Macro indicator time series (CPI, repo, USD/ZAR, PMI, etc.). v1 empty (no vendor contract on production); service_role writes.';

CREATE INDEX IF NOT EXISTS idx_macro_indicator_c_indicator_as_of
  ON public.macro_indicator_c (indicator_id, as_of DESC);

ALTER TABLE public.macro_indicator_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny anon/auth; service_role bypasses RLS.

-- ─── macro_release_c — upcoming economic release calendar ────────────
CREATE TABLE IF NOT EXISTS public.macro_release_c (
  release_id    TEXT         PRIMARY KEY,                       -- e.g. "ZA.CPI.2026-07-23"
  indicator_id  TEXT         NOT NULL,
  name          TEXT         NOT NULL,
  release_at    TIMESTAMPTZ  NOT NULL,
  country       TEXT         NOT NULL,
  source        TEXT         NOT NULL,                          -- "StatsSA" | "SARB" | "BEA" | ...
  consensus     NUMERIC,
  prior         NUMERIC,
  importance    TEXT,                                            -- "high" | "medium" | "low"
  tags          TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.macro_release_c IS
  'Upcoming economic-release calendar entries. v1 empty; service_role writes.';

CREATE INDEX IF NOT EXISTS idx_macro_release_c_release_at
  ON public.macro_release_c (release_at);

ALTER TABLE public.macro_release_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny anon/auth; service_role bypasses RLS.

-- ─── news_item_c — wire / SENS / regulatory news ─────────────────────
CREATE TABLE IF NOT EXISTS public.news_item_c (
  item_id       TEXT         PRIMARY KEY,                       -- vendor-supplied identifier
  source        TEXT         NOT NULL,                          -- "SENS" | "Reuters" | "Bloomberg" | "Moneyweb" | ...
  category      TEXT,                                            -- "RESULTS" | "TRADING" | "DIVIDEND" | "DIRECTORATE" | "CAUTIONARY" | ...
  severity      TEXT,                                            -- "regulatory" | "high" | "medium" | "low"
  ticker        TEXT,
  issuer        TEXT,
  headline      TEXT         NOT NULL,
  body          TEXT,
  url           TEXT,
  published_at  TIMESTAMPTZ  NOT NULL,
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.news_item_c IS
  'Wire / SENS / regulatory news items. v1 empty (no vendor contract on production); service_role writes.';

CREATE INDEX IF NOT EXISTS idx_news_item_c_published_at
  ON public.news_item_c (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_item_c_ticker
  ON public.news_item_c (ticker);

CREATE INDEX IF NOT EXISTS idx_news_item_c_category
  ON public.news_item_c (category);

ALTER TABLE public.news_item_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny anon/auth; service_role bypasses RLS.
