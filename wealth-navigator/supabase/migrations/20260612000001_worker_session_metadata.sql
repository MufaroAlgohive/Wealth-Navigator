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
