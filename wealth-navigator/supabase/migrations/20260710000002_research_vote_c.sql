-- research_vote_c — IC voting record for research_note_c.
-- Mint OEM Finalisation Phase A5. Review-only.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS research_vote_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES research_note_c(id) ON DELETE CASCADE,
  voter_email TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('yes','no','abstain')),
  rationale TEXT,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(note_id, voter_email)
);

CREATE INDEX IF NOT EXISTS idx_research_vote_note ON research_vote_c(note_id);
CREATE INDEX IF NOT EXISTS idx_research_vote_voter ON research_vote_c(voter_email);

ALTER TABLE research_vote_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_vote_service_role ON research_vote_c;
CREATE POLICY research_vote_service_role ON research_vote_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
