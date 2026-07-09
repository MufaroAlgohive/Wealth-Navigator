-- ic_session_c — Investment Committee meeting record.
-- Mint OEM Finalisation Phase A5. Review-only.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS ic_session_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_for TIMESTAMPTZ NOT NULL,
  agenda JSONB NOT NULL DEFAULT '[]'::jsonb,
  attendees TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ic_session_status ON ic_session_c(status);
CREATE INDEX IF NOT EXISTS idx_ic_session_scheduled ON ic_session_c(scheduled_for);

ALTER TABLE ic_session_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ic_session_service_role ON ic_session_c;
CREATE POLICY ic_session_service_role ON ic_session_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
