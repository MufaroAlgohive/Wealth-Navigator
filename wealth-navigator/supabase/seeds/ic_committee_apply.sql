-- =============================================================================
-- IC Committee — APPLY (paste-and-run)
-- =============================================================================
-- The committee roster has been discovered:
--   Lonwabo Damane  -> lonwabo@mymint.co.za        (admin · chair)
--   Juan Van Wyk    -> juan.vanwyk@mymint.co.za    (staff · voting)
--   Lethabo Maloma  -> lethabo.maloma@mymint.co.za  (staff · voting)
--
-- This script does BOTH DBs (when run via the right editor). DO NOT run this
-- whole file against a single project — pick the section that matches the
-- project you have open. The first line of each section names the project.
-- =============================================================================


-- ───────────────────────────────────────────────────────────────────────────
-- PART A — RETAIL DB (mfxnghmuccehsxwcetej)
-- ───────────────────────────────────────────────────────────────────────────
-- Grants the three granular permissions on the matched admin_team rows.
-- Idempotent — re-running just re-sets the same JSON values.

BEGIN;

UPDATE admin_team
SET
  permissions = jsonb_set(
    jsonb_set(
      jsonb_set(
        COALESCE(permissions, '{}'::jsonb),
        '{research,cast_vote}',
        'true'::jsonb,
        true
      ),
      '{rebalance,approve_rebalance}',
      'true'::jsonb,
      true
    ),
    '{research,approve_note}',
    'true'::jsonb,
    true
  ),
  updated_at = NOW()
WHERE lower(email) IN (
    lower('lonwabo@mymint.co.za'),
    lower('juan.vanwyk@mymint.co.za'),
    lower('lethabo.maloma@mymint.co.za')
  );

-- Verify the grants landed (READ-ONLY, runs inside the txn).
SELECT
  email,
  full_name,
  role,
  permissions->'research'->>'cast_vote'          AS research_cast_vote,
  permissions->'rebalance'->>'approve_rebalance' AS rebalance_approve,
  permissions->'research'->>'approve_note'       AS research_approve
FROM admin_team
WHERE lower(email) IN (
    lower('lonwabo@mymint.co.za'),
    lower('juan.vanwyk@mymint.co.za'),
    lower('lethabo.maloma@mymint.co.za')
  )
ORDER BY full_name;

COMMIT;


-- ───────────────────────────────────────────────────────────────────────────
-- PART B — INSTITUTIONAL DB (nnwzhxfjpjbzujevwzlh)
-- ───────────────────────────────────────────────────────────────────────────
-- (a) ensure committee_member_c exists, (b) fix the @CHANGE-ME rows from the
-- earlier run by replacing the emails with the real addresses.

BEGIN;

-- a. Idempotent table create (matches ic_committee_institutional.sql).
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

-- b. Delete the placeholder @CHANGE-ME rows seeded earlier (they were inserted
--    with the wrong UNIQUE key — without it the UPSERT below would conflict
--    instead of updating). Safe: these are dummy rows.
DELETE FROM committee_member_c WHERE voter_email LIKE '%@CHANGE-ME';

-- c. Seed the three real members. ON CONFLICT(voter_email) overwrites.
INSERT INTO committee_member_c (voter_email, display_name, initials, role, is_active)
VALUES
  ('lonwabo@mymint.co.za',       'Lonwabo Damane', 'LN', 'chair',  TRUE),
  ('juan.vanwyk@mymint.co.za',   'Juan Van Wyk',   'JN', 'voting', TRUE),
  ('lethabo.maloma@mymint.co.za','Lethabo Maloma', 'LT', 'voting', TRUE)
ON CONFLICT (voter_email) DO UPDATE
SET display_name = EXCLUDED.display_name,
    initials     = EXCLUDED.initials,
    role         = EXCLUDED.role,
    is_active    = EXCLUDED.is_active,
    updated_at   = NOW();

-- Verify the roster (READ-ONLY).
SELECT voter_email, display_name, initials, role, is_active
FROM committee_member_c
ORDER BY role, display_name;

COMMIT;
