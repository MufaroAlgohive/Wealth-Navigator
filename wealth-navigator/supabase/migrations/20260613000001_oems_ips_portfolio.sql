-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- IPS portfolio mirror tables. Worker calls
--   * IPSAccountGetAll1
--   * IPSPositionGetAll1
--   * IPSTransactionGetByAccount5
-- and upserts the result into the three tables below. v1 is read-only: the
-- worker never issues an order from these rows — they are the audit / dashboard
-- mirror of the IRESS Investment Portfolio Service.
--
-- Idempotent: safe to run multiple times.
-- No DROP / TRUNCATE / DELETE (the spec allows DROP POLICY IF EXISTS only).

-- ─── 1. oems_account_c — IPS accounts snapshot ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.oems_account_c (
  account_code text PRIMARY KEY,                      -- IRESS AccountCode
  account_name text,
  account_type text,                                  -- MARGIN / SETTLEMENT / CUSTODY / ...
  currency text,
  base_currency text,
  beneficiary text,
  account_status text,
  open_date date,
  nav_value numeric,                                  -- currency-native (not cents)
  cash_balance numeric,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,         -- full IPSAccountGetAll1 row
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.oems_account_c IS
  'IPS account mirror. Worker calls IPSAccountGetAll1 and upserts. service_role writes; RLS denies anon/auth.';

CREATE INDEX IF NOT EXISTS oems_account_c_ingested_at_idx
  ON public.oems_account_c (ingested_at DESC);

-- ─── 2. oems_position_c — IPS open positions snapshot ─────────────────────
CREATE TABLE IF NOT EXISTS public.oems_position_c (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code text NOT NULL,                         -- IRESS AccountCode
  security_code text NOT NULL,                        -- JSE ticker / RIC
  exchange text,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  open_average_price numeric,                         -- currency-native
  market_value numeric,                               -- currency-native mark-to-market
  open_pl numeric,                                    -- currency-native unrealised P&L
  currency text,
  open_date date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,         -- full IPSPositionGetAll1 row
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_code, security_code)
);

COMMENT ON TABLE public.oems_position_c IS
  'IPS open positions mirror. Worker calls IPSPositionGetAll1 and upserts. service_role writes; RLS denies anon/auth.';

CREATE INDEX IF NOT EXISTS oems_position_c_account_idx
  ON public.oems_position_c (account_code);

CREATE INDEX IF NOT EXISTS oems_position_c_security_idx
  ON public.oems_position_c (security_code);

CREATE INDEX IF NOT EXISTS oems_position_c_ingested_at_idx
  ON public.oems_position_c (ingested_at DESC);

-- ─── 3. oems_transaction_c — IPS transaction history ──────────────────────
CREATE TABLE IF NOT EXISTS public.oems_transaction_c (
  transaction_number text PRIMARY KEY,                -- IRESS TransactionNumber
  account_code text NOT NULL,
  tx_date date NOT NULL,
  tx_type text NOT NULL,                              -- BUY / SELL / DIV / ...
  security_code text NOT NULL,
  quantity numeric,
  price numeric,
  amount numeric,
  currency text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,         -- full IPSTransactionGetByAccount5 row
  ingested_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.oems_transaction_c IS
  'IPS transaction mirror. Worker calls IPSTransactionGetByAccount5 per account and upserts. service_role writes; RLS denies anon/auth.';

CREATE INDEX IF NOT EXISTS oems_transaction_c_account_date_idx
  ON public.oems_transaction_c (account_code, tx_date DESC);

CREATE INDEX IF NOT EXISTS oems_transaction_c_security_idx
  ON public.oems_transaction_c (security_code);

CREATE INDEX IF NOT EXISTS oems_transaction_c_ingested_at_idx
  ON public.oems_transaction_c (ingested_at DESC);

-- ─── RLS: deny anon / authenticated (service_role bypasses) ────────────────
ALTER TABLE public.oems_account_c ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oems_position_c ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oems_transaction_c ENABLE ROW LEVEL SECURITY;
-- No policies = deny for anon/authenticated; service_role still has full access.
