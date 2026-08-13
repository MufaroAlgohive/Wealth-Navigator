-- Per-environment manual rebalance decision control. Run against INSTITUTIONAL.
ALTER TABLE committee_governance_policy_c
  ADD COLUMN IF NOT EXISTS manual_rebalance_decision_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE committee_governance_policy_c
SET manual_rebalance_decision_enabled = COALESCE(manual_rebalance_decision_enabled, FALSE);
