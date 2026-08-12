-- Separate LIVE and UAT IC governance. Run against the institutional database.
ALTER TABLE rebalance_request_c
  ADD COLUMN IF NOT EXISTS environment_scope TEXT NOT NULL DEFAULT 'live'
  CHECK (environment_scope IN ('live', 'uat'));

CREATE TABLE IF NOT EXISTS committee_governance_member_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_scope TEXT NOT NULL CHECK (environment_scope IN ('live', 'uat')),
  voter_email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  initials TEXT,
  role TEXT NOT NULL DEFAULT 'voting' CHECK (role IN ('chair', 'voting', 'observer')),
  vote_scope TEXT[] NOT NULL DEFAULT ARRAY['rebalance', 'research'],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (environment_scope, voter_email)
);

CREATE TABLE IF NOT EXISTS committee_governance_policy_c (
  environment_scope TEXT PRIMARY KEY CHECK (environment_scope IN ('live', 'uat')),
  approval_mode TEXT NOT NULL DEFAULT 'count' CHECK (approval_mode IN ('count', 'percentage')),
  required_yes_count INTEGER NOT NULL DEFAULT 2 CHECK (required_yes_count >= 1),
  required_yes_percent NUMERIC NOT NULL DEFAULT 66.67 CHECK (required_yes_percent > 0 AND required_yes_percent <= 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO committee_governance_policy_c (environment_scope, approval_mode, required_yes_count, required_yes_percent)
VALUES ('live', 'count', 2, 66.67), ('uat', 'count', 2, 66.67)
ON CONFLICT (environment_scope) DO NOTHING;

-- Preserve the current LIVE rule on first deployment: the existing standing
-- committee remains three voters and two YES votes are required. UAT starts
-- intentionally empty and must be configured independently by a master/dev.
INSERT INTO committee_governance_member_c
  (environment_scope, voter_email, display_name, initials, role, vote_scope, is_active)
VALUES
  ('live', 'lonwabo@mymint.co.za', 'Lonwabo', 'LN', 'chair', ARRAY['rebalance', 'research'], TRUE),
  ('live', 'juan@autonama.co.za', 'Juan', 'JN', 'voting', ARRAY['rebalance', 'research'], TRUE),
  ('live', 'lethabo.maloma@mymint.co.za', 'Lethabo', 'LT', 'voting', ARRAY['rebalance', 'research'], TRUE)
ON CONFLICT (environment_scope, voter_email) DO NOTHING;

ALTER TABLE committee_governance_member_c ENABLE ROW LEVEL SECURITY;
ALTER TABLE committee_governance_policy_c ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS committee_governance_member_service_role ON committee_governance_member_c;
DROP POLICY IF EXISTS committee_governance_policy_service_role ON committee_governance_policy_c;
CREATE POLICY committee_governance_member_service_role ON committee_governance_member_c FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY committee_governance_policy_service_role ON committee_governance_policy_c FOR ALL TO service_role USING (true) WITH CHECK (true);
