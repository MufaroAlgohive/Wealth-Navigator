-- research_note_c — analyst-authored stock theses flowing through the IC pipeline.
-- Mint OEM Finalisation Phase A5 (DB scaffolding for Research / IC / Rebalance).
-- Review-only; paste into the institutional Supabase SQL editor.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS research_note_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  author_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','ic_pending','approved','rejected')),
  thesis JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggers JSONB,
  valuation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  ic_session_id UUID
);

CREATE INDEX IF NOT EXISTS idx_research_note_status ON research_note_c(status);
CREATE INDEX IF NOT EXISTS idx_research_note_symbol ON research_note_c(symbol);
CREATE INDEX IF NOT EXISTS idx_research_note_author ON research_note_c(author_email);

ALTER TABLE research_note_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_note_service_role ON research_note_c;
CREATE POLICY research_note_service_role ON research_note_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
