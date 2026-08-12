import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export type CommitteeEnvironment = "live" | "uat";
export type VotePurpose = "rebalance" | "research";
export type ApprovalMode = "count" | "percentage";

export interface GovernanceMember {
  voter_email: string;
  display_name: string;
  initials: string | null;
  role: "chair" | "voting" | "observer";
  vote_scope: VotePurpose[];
  is_active: boolean;
}
export interface GovernancePolicy {
  environment_scope: CommitteeEnvironment;
  approval_mode: ApprovalMode;
  required_yes_count: number;
  required_yes_percent: number;
  auto_decide_research: boolean;
  manual_research_decision_enabled: boolean;
}

const defaultPolicy = (environment_scope: CommitteeEnvironment): GovernancePolicy => ({
  environment_scope,
  approval_mode: "count",
  required_yes_count: 2,
  required_yes_percent: 66.67,
  auto_decide_research: true,
  manual_research_decision_enabled: false,
});

export async function governanceFor(scope: CommitteeEnvironment) {
  const db = createInstitutionalServiceRoleClient();
  const [membersRes, policyRes] = await Promise.all([
    db
      .from("committee_governance_member_c")
      .select("voter_email, display_name, initials, role, vote_scope, is_active")
      .eq("environment_scope", scope)
      .eq("is_active", true),
    db
      .from("committee_governance_policy_c")
      .select("environment_scope, approval_mode, required_yes_count, required_yes_percent, auto_decide_research, manual_research_decision_enabled")
      .eq("environment_scope", scope)
      .maybeSingle(),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (policyRes.error) throw policyRes.error;
  return {
    members: (membersRes.data ?? []) as GovernanceMember[],
    policy: (policyRes.data as GovernancePolicy | null) ?? defaultPolicy(scope),
    db,
  };
}

export function requiredYes(policy: GovernancePolicy, eligibleVoters: number): number {
  return policy.approval_mode === "percentage"
    ? Math.max(1, Math.ceil((Math.max(1, eligibleVoters) * policy.required_yes_percent) / 100))
    : Math.max(1, policy.required_yes_count);
}
