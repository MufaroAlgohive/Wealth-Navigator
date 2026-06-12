-- =============================================================================
-- Mint Wealth Navigator — THROWAWAY TEST PROJECT (ref nnwzhxfjpjbzujevwzlh)
-- Combined migration file for one-shot paste into Supabase SQL editor.
-- Run order: paste the whole file in one go. All statements are idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1/5 — integration_worker_health (heartbeat table for the IRESS ingest worker)
-- -----------------------------------------------------------------------------

-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- Worker heartbeat table for Railway IRESS ingest (not in TABLES.md — worker extension).
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.integration_worker_health (
  worker_id text PRIMARY KEY,
  service_name text NOT NULL DEFAULT 'iress-ingest',
  status text NOT NULL DEFAULT 'unknown',
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_quote_sync_at timestamptz,
  iress_mode text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.integration_worker_health IS
  'Railway/long-running worker heartbeats (IRESS ingest, future pipelines).';

-- Service role bypasses RLS; anon/authenticated should not read infra heartbeats by default.
ALTER TABLE public.integration_worker_health ENABLE ROW LEVEL SECURITY;

-- No policies = deny for anon/authenticated; service_role still has full access.


-- -----------------------------------------------------------------------------
-- 2/5 — worker_session_metadata (sticky ApplicationID per worker node)
-- -----------------------------------------------------------------------------

-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- Sticky ApplicationID per Railway worker node.
-- IRESS recovers the SOAP session for the same (UserName + CompanyName + ApplicationID)
-- triple, so persisting the ApplicationID across restarts lets the worker reconnect
-- to the same in-flight CT license seat without burning a fresh session.
--
-- Idempotent: safe to run multiple times.
-- No DROP / TRUNCATE / DELETE.

CREATE TABLE IF NOT EXISTS public.worker_session_metadata (
  worker_id text PRIMARY KEY,
  application_id text NOT NULL,
  iress_session_key text,
  iress_hostname text,
  last_started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.worker_session_metadata IS
  'Sticky ApplicationID per Railway worker node — IRESS recovers the SOAP session for the same (UserName + CompanyName + ApplicationID) triple. service_role only.';

CREATE INDEX IF NOT EXISTS worker_session_metadata_application_id_idx
  ON public.worker_session_metadata (application_id);

CREATE INDEX IF NOT EXISTS worker_session_metadata_expires_at_idx
  ON public.worker_session_metadata (expires_at);

-- Service role bypasses RLS; anon/authenticated should not read infra metadata by default.
ALTER TABLE public.worker_session_metadata ENABLE ROW LEVEL SECURITY;
-- No policies = deny for anon/authenticated; service_role still has full access.


-- -----------------------------------------------------------------------------
-- 3/5 — oems_order_audit (read-only audit mirror of OrderPadGetByAccount)
-- -----------------------------------------------------------------------------

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


-- -----------------------------------------------------------------------------
-- 4/5 — Read-only RLS policies for stock_intraday_c + securities_c (UI hot path)
-- -----------------------------------------------------------------------------

-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- Read-only RLS policies for the UI hot path:
--   anon / authenticated can SELECT from stock_intraday_c and securities_c
--   writes remain service_role only (the worker keeps using service_role).
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY pattern.
-- No DROP / TRUNCATE / DELETE on tables; policies only.

ALTER TABLE public.stock_intraday_c ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.securities_c    ENABLE ROW LEVEL SECURITY;

-- Re-run-safe: drop any prior copy of these policies first.
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

-- No INSERT / UPDATE / DELETE policies are created — only service_role (the worker)
-- can write. anon / authenticated see quotes / instrument metadata, never modify them.


-- -----------------------------------------------------------------------------
-- 5/5 — securities_with_latest_quote view (helper for OEMS read path)
-- -----------------------------------------------------------------------------

-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- Helper view: latest intraday snapshot per security.
--   Joins securities_c (instrument ref) with the most-recent stock_intraday_c row
--   per security_id so the UI can do a single query instead of a window function
--   per tick.
--
-- Idempotent: CREATE OR REPLACE VIEW.
-- No DROP / TRUNCATE / DELETE; view definition only. RLS is inherited from the
-- base tables (stock_intraday_c, securities_c) — anon / authenticated reads only
-- work after 20260612000003_intraday_read_policies.sql is applied.

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


-- =============================================================================
-- End of combined migration — safe to paste as a single SQL editor run.
-- =============================================================================
