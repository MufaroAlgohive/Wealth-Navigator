-- =============================================================================
-- IC Committee discovery + whitelist
-- =============================================================================
-- Purpose:
--   Identify the three Investment Committee (IC) voting members —
--   Lonwabo, Juan, Lethabo — by name match, and (optionally) formalise the
--   whitelist in a new `committee_member_c` table on the INSTITUTIONAL DB.
--
-- Run order:
--   1.  Run the DISCOVER block on the RETAIL DB (where auth.users + admin_team
--       live) to print the matching users' emails.
--   2.  Paste those three emails into the COMMITTEE block below (replace the
--       `'<EMAIL_LONWABO>'` etc. placeholders).
--   3.  Run the COMMITTEE block on the INSTITUTIONAL DB to create
--       `committee_member_c` and seed the 3 rows. Idempotent.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1 — DISCOVER (RETAIL DB; read-only)
-- -----------------------------------------------------------------------------
-- Matches admin_team rows by first name (case-insensitive). Pulls back the
-- email, full name, role, and the granular permissions JSON so you can confirm
-- the three members actually have the right `research.cast_vote` /
-- `rebalance.approve_rebalance` grants before promoting them to IC.
--
-- Tip: if `auth.users` is what you prefer to match against (in case an admin
-- has not yet been added to admin_team), uncomment the second query.
-- -----------------------------------------------------------------------------

SELECT
  at.email,
  at.full_name,
  at.role,
  at.status,
  at.page_access,
  -- Surface the IC-relevant granular permissions so we can verify them
  -- at a glance (NULL when not yet granted).
  at.permissions->'research'->>'cast_vote'          AS research_cast_vote,
  at.permissions->'research-lab'->>'cast_vote'      AS research_lab_cast_vote,
  at.permissions->'rebalance'->>'approve_rebalance' AS rebalance_approve,
  at.permissions->'research'->>'approve_note'       AS research_approve
FROM admin_team at
WHERE at.status = 'active'
  AND (
        split_part(at.full_name, ' ', 1) ILIKE 'Lonwabo'
     OR split_part(at.full_name, ' ', 1) ILIKE 'Juan'
     OR split_part(at.full_name, ' ', 1) ILIKE 'Lethabo'
  )
ORDER BY at.full_name;

-- Optional alternative — match auth.users directly by first name only
-- (works even when the user has not been added to admin_team yet).
--
-- SELECT
--   u.id            AS auth_user_id,
--   u.email,
--   u.raw_user_meta_data->>'full_name' AS full_name,
--   u.created_at
-- FROM auth.users u
-- WHERE
--       split_part(coalesce(u.raw_user_meta_data->>'full_name', ''), ' ', 1) ILIKE 'Lonwabo'
--    OR split_part(coalesce(u.raw_user_meta_data->>'full_name', ''), ' ', 1) ILIKE 'Juan'
--    OR split_part(coalesce(u.raw_user_meta_data->>'full_name', ''), ' ', 1) ILIKE 'Lethabo'
-- ORDER BY u.raw_user_meta_data->>'full_name';


-- -----------------------------------------------------------------------------
-- STEP 2 — BACKFILL admin_team grants (RETAIL DB; idempotent)
-- -----------------------------------------------------------------------------
-- Once you have the three emails from STEP 1, paste them into the placeholders
-- below and run. This is the RBAC side of the IC gate: each member needs the
-- granular permissions that let the vote API accept their ballot.
--
-- `research.cast_vote`         -> /api/research/notes/[id]/vote
-- `rebalance.approve_rebalance`-> /api/rebalance/requests/[id]/vote (voting IS the approval)
-- `research.approve_note`      -> chair override on the IC page
-- -----------------------------------------------------------------------------

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
    lower('lonwabo@mintsa.com'),   -- <- paste discovered email
    lower('juan@mintsa.com'),      -- <- paste discovered email
    lower('lethabo@mintsa.com')    -- <- paste discovered email
  );


-- -----------------------------------------------------------------------------
-- STEP 3 — COMMITTEE WHITELIST (INSTITUTIONAL DB; idempotent)
-- -----------------------------------------------------------------------------
-- Creates `committee_member_c` — the authoritative whitelist the vote route
-- checks before accepting a ballot. Even if a user accidentally inherits the
-- `cast_vote` permission, only listed emails can actually vote.
-- -----------------------------------------------------------------------------

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

-- Seed the three members. Replace the placeholder emails with the actual
-- values surfaced by STEP 1. UPSERT is idempotent — re-running this block
-- after fixing an email just overwrites the row.
INSERT INTO committee_member_c (voter_email, display_name, initials, role, is_active)
VALUES
  ('lonwabo@mintsa.com',  'Lonwabo',  'LN', 'chair',   TRUE),  -- chair / casting vote
  ('juan@mintsa.com',     'Juan',     'JN', 'voting',  TRUE),
  ('lethabo@mintsa.com',  'Lethabo',  'LT', 'voting',  TRUE)
ON CONFLICT (voter_email) DO UPDATE
SET display_name = EXCLUDED.display_name,
    initials     = EXCLUDED.initials,
    role         = EXCLUDED.role,
    is_active    = EXCLUDED.is_active,
    updated_at   = NOW();


-- -----------------------------------------------------------------------------
-- STEP 4 — VERIFY (INSTITUTIONAL DB)
-- -----------------------------------------------------------------------------
SELECT voter_email, display_name, initials, role, is_active, created_at
FROM committee_member_c
ORDER BY role, display_name;
