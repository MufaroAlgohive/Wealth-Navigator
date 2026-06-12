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
