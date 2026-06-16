-- REVIEW BEFORE APPLY — LIVE INSTITUTIONAL PROJECT (MyMint / OEMS).
-- Latest IRESS L1 quote snapshot per security, for the Security page's
-- "Quote · IRESS L1" panel (Prev Close / Open / Bid / Ask / Day's Range /
-- Volume / Last). The worker (workers/iress-ingest/src/quotes.ts) already
-- fetches the full PricingQuoteGet L1 row every cycle; this table persists it.
--
-- One row per (security_code, exchange) — the worker UPSERTs on that unique
-- key. 52-week range + average volume are optional (computed from
-- TimeSeriesGet2 on a slower cadence); null until populated.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No DROP/TRUNCATE.

CREATE TABLE IF NOT EXISTS public.quote_snapshot_c (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  security_code text         NOT NULL,
  exchange      text         NOT NULL DEFAULT 'JSE',
  last          numeric,
  open          numeric,
  high          numeric,
  low           numeric,
  bid           numeric,
  ask           numeric,
  prev_close    numeric,
  volume        numeric,
  vwap          numeric,
  week52_high   numeric,
  week52_low    numeric,
  avg_volume    numeric,
  currency      text,
  market_state  text,
  as_of         timestamptz,
  source        text         NOT NULL DEFAULT 'iress-worker',
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (security_code, exchange)
);

CREATE INDEX IF NOT EXISTS quote_snapshot_c_code_idx
  ON public.quote_snapshot_c (security_code);

ALTER TABLE public.quote_snapshot_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_snapshot_c read" ON public.quote_snapshot_c;
CREATE POLICY "quote_snapshot_c read"
  ON public.quote_snapshot_c FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "quote_snapshot_c service write" ON public.quote_snapshot_c;
CREATE POLICY "quote_snapshot_c service write"
  ON public.quote_snapshot_c FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.quote_snapshot_c IS
  'Latest IRESS L1 quote snapshot per (security_code, exchange). Populated by the Railway iress-ingest worker from PricingQuoteGet. Read-only for anon/authenticated; service_role writes.';
