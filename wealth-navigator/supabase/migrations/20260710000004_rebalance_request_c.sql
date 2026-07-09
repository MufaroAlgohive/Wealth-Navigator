-- rebalance_request_c — strategy rebalance proposals raised from research notes.
-- Mint OEM Finalisation Phase A5. Review-only.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS rebalance_request_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  current_composition JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_composition JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_investors JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ic_approved','rejected','executed','cancelled')),
  ic_session_id UUID REFERENCES ic_session_c(id),
  research_note_id UUID REFERENCES research_note_c(id),
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rebalance_request_status ON rebalance_request_c(status);
CREATE INDEX IF NOT EXISTS idx_rebalance_request_strategy ON rebalance_request_c(strategy_id);

ALTER TABLE rebalance_request_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rebalance_request_service_role ON rebalance_request_c;
CREATE POLICY rebalance_request_service_role ON rebalance_request_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
