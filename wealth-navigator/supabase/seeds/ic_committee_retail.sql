-- =============================================================================
-- IC Committee — DISCOVER + BACKFILL (RETAIL DB ONLY)
-- =============================================================================
-- ⚠️  RUN THIS ON THE RETAIL PROJECT (`mfxnghmuccehsxwcetej`).
--     The institutional project (`nnwzhxfjpjbzujevwzlh`) does NOT have the
--     `admin_team` table — that lives on retail where auth happens.
--
-- What this does:
--   STEP 1 — DISCOVER the three IC members (Lonwabo, Juan, Lethabo) by matching
--            their first name against `admin_team.full_name`. Falls back to
--            `auth.users.raw_user_meta_data->>'full_name'` when admin_team
--            hasn't been populated for them yet. READ-ONLY.
--
--   STEP 2 — BACKFILL the granular permissions JSONB on the matched rows so
--            the vote API will accept their ballots. IDEMPOTENT — re-running
--            overwrites with the same JSON values.
--
-- After running, copy the three `email` values from STEP 1 into STEP 3 of
-- the institutional script (see ic_committee_institutional.sql).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1 — DISCOVER (READ-ONLY)
-- -----------------------------------------------------------------------------
-- Returns rows for any admin whose first name matches Lonwabo / Juan / Lethabo.
-- Works whether the team row has `full_name` populated or not — joins to
-- auth.users by email when full_name is missing.
-- -----------------------------------------------------------------------------

WITH targets(name) AS (
  VALUES ('Lonwabo'), ('Juan'), ('Lethabo')
)
SELECT
  COALESCE(at.email, u.email)                                                AS email,
  COALESCE(at.full_name, u.raw_user_meta_data->>'full_name')                  AS full_name,
  at.role                                                                    AS admin_role,
  at.status                                                                  AS admin_status,
  -- IC-relevant granular permissions (NULL when not yet granted).
  at.permissions->'research'->>'cast_vote'                                   AS research_cast_vote,
  at.permissions->'research-lab'->>'cast_vote'                               AS research_lab_cast_vote,
  at.permissions->'rebalance'->>'approve_rebalance'                          AS rebalance_approve,
  at.permissions->'research'->>'approve_note'                                AS research_approve
FROM targets t
LEFT JOIN admin_team at
       ON at.status = 'active'
      AND split_part(COALESCE(at.full_name, ''), ' ', 1) ILIKE t.name
LEFT JOIN auth.users u
       ON split_part(COALESCE(u.raw_user_meta_data->>'full_name', ''), ' ', 1) ILIKE t.name
WHERE COALESCE(at.email, u.email) IS NOT NULL
ORDER BY t.name;


-- -----------------------------------------------------------------------------
-- STEP 2 — BACKFILL admin_team permissions (IDEMPOTENT)
-- -----------------------------------------------------------------------------
-- Grants the three granular permissions every IC member needs. Safe to re-run:
-- jsonb_set on the same key just overwrites with the same value.
--
--   research.cast_vote             -> /api/research/notes/[id]/vote
--   rebalance.approve_rebalance    -> /api/rebalance/requests/[id]/vote
--   research.approve_note          -> chair override on the IC page
--
-- Paste the three emails surfaced by STEP 1 into the IN list below before
-- running. The placeholder strings are the safest defaults to ship; replace
-- them with the real addresses.
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
    lower('lonwabo@CHANGE-ME'),   -- ← paste discovered email
    lower('juan@CHANGE-ME'),      -- ← paste discovered email
    lower('lethabo@CHANGE-ME')    -- ← paste discovered email
  );


-- -----------------------------------------------------------------------------
-- VERIFY (READ-ONLY)
-- -----------------------------------------------------------------------------
SELECT
  email,
  full_name,
  role,
  permissions->'research'->>'cast_vote'          AS research_cast_vote,
  permissions->'rebalance'->>'approve_rebalance' AS rebalance_approve,
  permissions->'research'->>'approve_note'       AS research_approve
FROM admin_team
WHERE lower(email) IN (
    lower('lonwabo@CHANGE-ME'),
    lower('juan@CHANGE-ME'),
    lower('lethabo@CHANGE-ME')
  )
ORDER BY full_name;
