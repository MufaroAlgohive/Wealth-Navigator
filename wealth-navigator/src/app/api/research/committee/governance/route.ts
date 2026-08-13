import { canManageCommittee, canSeeUatSurfaces, getAdminContext } from "@/lib/admin/rbac";
import {
  type CommitteeEnvironment,
  type GovernanceMember,
  type GovernancePolicy,
  governanceFor,
} from "@/lib/research-ic/governance";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const scopes: CommitteeEnvironment[] = ["live", "uat"];
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "The institutional governance tables have not been deployed yet.";
};

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok")
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  try {
    const visibleScopes = canSeeUatSurfaces(auth.ctx) ? scopes : ["live"] as CommitteeEnvironment[];
    const entries = await Promise.all(
      visibleScopes.map(async (scope) => [scope, await governanceFor(scope)] as const),
    );
    let team: Array<{ email: string; full_name: string | null }> = [];
    if (canManageCommittee(auth.ctx)) {
      try {
        const retail = createRetailServiceRoleClient();
        const { data } = await retail
          .from("admin_team")
          .select("email, full_name")
          .neq("status", "inactive")
          .order("full_name", { ascending: true });
        team = (data ?? []) as Array<{ email: string; full_name: string | null }>;
      } catch {
        // Governance remains usable with existing rows if the team directory is unavailable.
      }
    }
    return NextResponse.json({
      ok: true,
      scopes: Object.fromEntries(entries.map(([scope, { members, policy }]) => [scope, { members, policy }])),
      team,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `IC voting settings need a one-time database migration: ${errorMessage(error)}`,
        migration: "supabase/migrations/20260812000001_ic_governance.sql",
      },
      { status: 409 },
    );
  }
}

export async function PUT(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !canManageCommittee(auth.ctx))
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as {
    scope?: unknown;
    members?: unknown;
    policy?: unknown;
  } | null;
  const scope = body?.scope;
  if (
    (scope !== "live" && scope !== "uat") ||
    !Array.isArray(body?.members) ||
    !body?.policy ||
    typeof body.policy !== "object"
  )
    return NextResponse.json({ ok: false, error: "Invalid governance payload." }, { status: 400 });
  const members = body.members as GovernanceMember[];
  const policy = body.policy as GovernancePolicy;
  if (
    members.some(
      (m) =>
        !m.voter_email ||
        !m.display_name ||
        !Array.isArray(m.vote_scope) ||
        m.vote_scope.some((v) => v !== "rebalance" && v !== "research"),
    )
  )
    return NextResponse.json(
      { ok: false, error: "Each voter needs an email, name and valid vote permissions." },
      { status: 400 },
    );
  if (policy.approval_mode !== "count" && policy.approval_mode !== "percentage")
    return NextResponse.json({ ok: false, error: "Invalid approval mode." }, { status: 400 });
  try {
    const { db } = await governanceFor(scope);
    const rows = members.map((m) => ({
      ...m,
      environment_scope: scope,
      voter_email: m.voter_email.toLowerCase(),
      updated_at: new Date().toISOString(),
    }));
    const del = await db.from("committee_governance_member_c").delete().eq("environment_scope", scope);
    if (del.error) throw del.error;
    if (rows.length) {
      const upsert = await db.from("committee_governance_member_c").insert(rows);
      if (upsert.error) throw upsert.error;
    }
    const policyUpsert = await db.from("committee_governance_policy_c").upsert({
      environment_scope: scope,
      approval_mode: policy.approval_mode,
      required_yes_count: Math.max(1, Math.floor(Number(policy.required_yes_count) || 1)),
      required_yes_percent: Math.min(100, Math.max(1, Number(policy.required_yes_percent) || 1)),
      auto_decide_research: policy.auto_decide_research !== false,
      manual_research_decision_enabled: policy.manual_research_decision_enabled === true,
      manual_rebalance_decision_enabled: policy.manual_rebalance_decision_enabled === true,
      updated_at: new Date().toISOString(),
    });
    if (policyUpsert.error) throw policyUpsert.error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
