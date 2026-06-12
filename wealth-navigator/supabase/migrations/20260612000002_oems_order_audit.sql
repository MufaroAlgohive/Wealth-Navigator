-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- OEMS order/event audit trail. Worker reads via OrderPadGetByAccount and writes a
-- row per observed order. v1 is read-only: the worker never POSTs orders; this is
-- an audit mirror, not a control table.
--
-- Idempotent: safe to run multiple times.
-- No DROP / TRUNCATE / DELETE (the spec allows DROP POLICY IF EXISTS only).

CREATE TABLE IF NOT EXISTS public.oems_order_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,                          -- IRESS OrderNumber / tag
  client_account text NOT NULL,                    -- IRESS AccountCode
  symbol text NOT NULL,                            -- JSE ticker
  side text NOT NULL CHECK (side IN ('buy','sell','sell_short','buy_cover')),
  quantity numeric NOT NULL CHECK (quantity > 0),
  price_cents numeric,                             -- IRESS price * 100 (Rands → cents)
  status text NOT NULL CHECK (status IN ('created','working','filled','partial','cancelled','rejected','amended')),
  source text NOT NULL DEFAULT 'IRESS',            -- UI, API, BATCH, IRESS
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,      -- raw OrderPadGetByAccount row
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.oems_order_audit IS
  'OEMS order/event audit mirror. v1 is read-only: worker polls OrderPadGetByAccount and upserts observed orders. service_role writes.';

CREATE INDEX IF NOT EXISTS oems_order_audit_order_id_idx
  ON public.oems_order_audit (order_id);

CREATE INDEX IF NOT EXISTS oems_order_audit_client_account_idx
  ON public.oems_order_audit (client_account);

CREATE INDEX IF NOT EXISTS oems_order_audit_created_at_idx
  ON public.oems_order_audit (created_at DESC);

-- updated_at is supplied by the worker on each upsert — no DB trigger needed,
-- and the spec forbids DROP / TRUNCATE / DELETE in this migration set.

ALTER TABLE public.oems_order_audit ENABLE ROW LEVEL SECURITY;
-- No policies = deny for anon/authenticated; service_role still has full access.
