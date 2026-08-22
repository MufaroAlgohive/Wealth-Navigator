-- REVIEW BEFORE APPLY — INSTITUTIONAL project nnwzhxfjpjbzujevwzlh
-- State container for /api/cron/iress-monitor (outage → Discord webhook
-- transition detection + re-alert dedup). Lives in the same DB as the
-- worker heartbeats it reads (integration_worker_health).
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.monitor_state_c (
  monitor_id text PRIMARY KEY,
  state text NOT NULL,                          -- 'online' | 'offline'
  first_detected_at timestamptz,
  last_transition_at timestamptz,
  last_alert_at timestamptz,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.monitor_state_c IS
  'Last-known state + alert timestamps for BFF cron monitors (iress-feed).';

-- Service role bypasses RLS; anon/authenticated should not read infra state.
ALTER TABLE public.monitor_state_c ENABLE ROW LEVEL SECURITY;

-- No policies = deny for anon/authenticated; service_role still has full access.