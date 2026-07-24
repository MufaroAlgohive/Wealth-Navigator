-- =============================================================================
-- IC Committee — WHITELIST (INSTITUTIONAL DB ONLY)
-- =============================================================================
-- ⚠️  RUN THIS ON THE INSTITUTIONAL PROJECT (`nnwzhxfjpjbzujevwzlh`).
--     The whitelist table (`committee_member_c`) lives here because that is
--     where `research_vote_c` and `rebalance_vote_c` are written — the vote
--     API checks this table before accepting a ballot.
--
-- What this does:
--   - Creates `committee_member_c` with a UNIQUE `voter_email` and a CHECK
--     on the role enum (chair / voting / observer). Idempotent.
--   - Seeds Lonwabo (chair), Juan, Lethabo — UPSERT means re-running after
--     fixing an email just overwrites the row.
--   - Enables RLS with a service-role policy so the BFF vote route can read.
--
-- Run AFTER you've executed ic_committee_retail.sql and have the three emails.
-- Replace the `'<EMAIL>'` placeholders below with the actual addresses.
-- =============================================================================


CREATE TABLE IF NOT EXISTS committee_member_c (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_email  TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  initials     TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'voting'
                  CHECK (role IN ('chair', 'voting', 'observer')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_committee_member_active
  ON committee_member_c (is_active) WHERE is_active = TRUE;

ALTER TABLE committee_member_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS committee_member_service_role ON committee_member_c;
CREATE POLICY committee_member_service_role ON committee_member_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed the three members. ON CONFLICT keeps the seed idempotent.
INSERT INTO committee_member_c (voter_email, display_name, initials, role, is_active)
VALUES
  ('lonwabo@CHANGE-ME',  'Lonwabo',  'LN', 'chair',   TRUE),  -- chair / casting vote
  ('juan@CHANGE-ME',     'Juan',     'JN', 'voting',  TRUE),
  ('lethabo@CHANGE-ME',  'Lethabo',  'LT', 'voting',  TRUE)
ON CONFLICT (voter_email) DO UPDATE
SET display_name = EXCLUDED.display_name,
    initials     = EXCLUDED.initials,
    role         = EXCLUDED.role,
    is_active    = EXCLUDED.is_active,
    updated_at   = NOW();


-- -----------------------------------------------------------------------------
-- VERIFY (READ-ONLY)
-- -----------------------------------------------------------------------------
SELECT voter_email, display_name, initials, role, is_active, created_at
FROM committee_member_c
ORDER BY role, display_name;
