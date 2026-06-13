-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh
-- Idempotent: safe to run multiple times.
--
-- Worker diagnostic events now live inside
-- `public.integration_worker_health.metadata.recent_events` (JSONB),
-- written by `workers/iress-ingest/src/events.ts` on every heartbeat.
-- The /oems/integration page reads them via GET /api/worker-health.
--
-- This migration exists as a no-op marker so the audit trail records
-- *why* no new table or column was added for `worker_recent_events`.
-- We considered a dedicated `worker_recent_events` table keyed by
-- (worker_id, ts) with one row per event, but:
--
--   1. The events are ephemeral diagnostic data (capped at 50 newest
--      per worker, in-process ring buffer, lost on worker restart).
--      Postgres row-per-event storage would cost more than it saves.
--   2. The events are read in JSON, rendered in a single UI table —
--      no analytical query pattern needs row-per-event storage.
--   3. JSONB inside `metadata` keeps the heartbeat table the single
--      source of truth for worker state, avoiding a join on the
--      integration page.
--
-- If we later need time-range queries or event-type aggregations we
-- can promote this to a real table; the JSONB shape documented in
-- `src/lib/iress/types.ts#WorkerEvent` is the contract to keep stable.

DO $$
BEGIN
  -- Intentional no-op. See the comment block above for the design
  -- rationale. Asserting the JSONB GIN index *is* available so we
  -- can later add per-symbol or per-event-type aggregations without
  -- another migration.
  PERFORM 1
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'integration_worker_health';
  -- No ALTER / CREATE / UPDATE here. The BFF reads
  -- metadata.recent_events verbatim; the worker writes it on every
  -- heartbeat via the JSONB upsert path in
  -- workers/iress-ingest/src/supabase.ts#writeHeartbeat.
END$$;

COMMENT ON COLUMN public.integration_worker_health.metadata IS
  'Free-form worker state. Today: {symbols_covered, symbol_exchanges, accounts, account_configured, recent_events}. `recent_events` is a newest-first array of {ts, level, event, msg?, data?} written by workers/iress-ingest/src/events.ts and surfaced in /oems/integration so the operator can diagnose ingest failures without tailing Railway logs. Capped at 50 events per worker.';
