-- Per-environment research decision controls. Run against INSTITUTIONAL.
ALTER TABLE committee_governance_policy_c
  ADD COLUMN IF NOT EXISTS auto_decide_research BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS manual_research_decision_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE committee_governance_policy_c
SET auto_decide_research = COALESCE(auto_decide_research, TRUE),
    manual_research_decision_enabled = COALESCE(manual_research_decision_enabled, FALSE);
