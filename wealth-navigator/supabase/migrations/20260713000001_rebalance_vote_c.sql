-- rebalance_vote_c — IC voting record for rebalance_request_c.
-- A proposal is promoted pending -> ic_approved once YES votes cross the
-- committee threshold (see src/lib/rebalance/ic-vote.ts: quorum 3, 60%).
-- Mirrors research_vote_c. Institutional (nnwz). Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS rebalance_vote_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES rebalance_request_c(id) ON DELETE CASCADE,
  voter_email TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('yes','no','abstain')),
  rationale TEXT,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(request_id, voter_email)
);

CREATE INDEX IF NOT EXISTS idx_rebalance_vote_request ON rebalance_vote_c(request_id);
CREATE INDEX IF NOT EXISTS idx_rebalance_vote_voter ON rebalance_vote_c(voter_email);

ALTER TABLE rebalance_vote_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rebalance_vote_service_role ON rebalance_vote_c;
CREATE POLICY rebalance_vote_service_role ON rebalance_vote_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
