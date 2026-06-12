-- ──────────────────────────────────────────────────────────────────────
-- _test_seed_securities.sql — THROWAWAY test project (ref nnwzhxfjpjbzujevwzlh)
-- ──────────────────────────────────────────────────────────────────────
-- Idempotent seed for the worker E2E flow. Creates the consumer
-- `securities_c` table if it does not exist (the table is documented
-- in TABLES.md; the live project already has it), and seeds 10 JSE
-- Top-40 instruments with realistic prices in cents.
--
-- Drop-in companion for migrations 20260612000003 and 20260612000004 —
-- re-apply migration 04 after this seed to materialise
-- `securities_with_latest_quote`.
--
-- The live project DOES NOT need this — the column shape matches the
-- TABLES.md schema for `securities_c`.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.securities_c (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text UNIQUE NOT NULL,
  name text,
  last_price numeric,
  sector text,
  asset_type text DEFAULT 'stock',
  ytd_start_price numeric,
  currency text
);

ALTER TABLE public.securities_c
  ADD COLUMN IF NOT EXISTS currency text;

CREATE TABLE IF NOT EXISTS public.stock_intraday_c (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES public.securities_c(id) ON DELETE CASCADE,
  current_price numeric NOT NULL,
  "timestamp" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_intraday_c_security_id_idx
  ON public.stock_intraday_c (security_id);

CREATE INDEX IF NOT EXISTS stock_intraday_c_timestamp_idx
  ON public.stock_intraday_c ("timestamp" DESC);

-- Re-apply read policies now that the base tables exist.
ALTER TABLE public.stock_intraday_c ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.securities_c    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read stock_intraday_c"   ON public.stock_intraday_c;
DROP POLICY IF EXISTS "auth read stock_intraday_c"   ON public.stock_intraday_c;
DROP POLICY IF EXISTS "anon read securities_c"       ON public.securities_c;
DROP POLICY IF EXISTS "auth read securities_c"       ON public.securities_c;

CREATE POLICY "anon read stock_intraday_c"
  ON public.stock_intraday_c
  FOR SELECT TO anon USING (true);
CREATE POLICY "auth read stock_intraday_c"
  ON public.stock_intraday_c
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "anon read securities_c"
  ON public.securities_c
  FOR SELECT TO anon USING (true);
CREATE POLICY "auth read securities_c"
  ON public.securities_c
  FOR SELECT TO authenticated USING (true);

-- Materialise the latest-quote view.
CREATE OR REPLACE VIEW public.securities_with_latest_quote AS
SELECT
  s.id            AS security_id,
  s.symbol,
  s.name,
  s.sector,
  s.asset_type,
  s.last_price,
  s.ytd_start_price,
  i.current_price AS latest_intraday_price,
  i.timestamp     AS latest_intraday_at
FROM public.securities_c s
LEFT JOIN LATERAL (
  SELECT current_price, timestamp
  FROM public.stock_intraday_c si
  WHERE si.security_id = s.id
  ORDER BY si.timestamp DESC
  LIMIT 1
) i ON true;

COMMENT ON VIEW public.securities_with_latest_quote IS
  'Latest stock_intraday_c snapshot per security_id; pairs with securities_c for OEMS read path. RLS inherited from base tables.';

-- Seed: JSE Top-40, prices in cents. ytd_start_price ≈ ~10% below last.
INSERT INTO public.securities_c (symbol, name, last_price, sector, asset_type, ytd_start_price, currency) VALUES
  ('NPN',  'Naspers Limited',           281234, 'Media',                'stock', 255000, 'ZAR'),
  ('PRX',  'Prosus N.V.',               113500, 'Internet',             'stock', 102000, 'ZAR'),
  ('FSR',  'FirstRand Limited',          71450, 'Banks',                'stock',  65000, 'ZAR'),
  ('SBK',  'Standard Bank Group',        21580, 'Banks',                'stock',  19500, 'ZAR'),
  ('AGL',  'Anglo American plc',        412600, 'Mining',               'stock', 380000, 'ZAR'),
  ('BHG',  'Bid Corporation Limited',   442800, 'Retail',               'stock', 395000, 'ZAR'),
  ('MTN',  'MTN Group Limited',          11825, 'Telecommunications',   'stock',  10800, 'ZAR'),
  ('SOL',  'Sasol Limited',              11450, 'Oil & Gas',            'stock',  12500, 'ZAR'),
  ('SHP',  'Shoprite Holdings',         245600, 'Retail',               'stock', 220000, 'ZAR'),
  ('CPI',  'Capitec Bank Holdings',    2685000, 'Banks',               'stock',2400000, 'ZAR')
ON CONFLICT (symbol) DO UPDATE SET
  name            = EXCLUDED.name,
  last_price      = EXCLUDED.last_price,
  sector          = EXCLUDED.sector,
  asset_type      = EXCLUDED.asset_type,
  ytd_start_price = EXCLUDED.ytd_start_price,
  currency        = EXCLUDED.currency;
