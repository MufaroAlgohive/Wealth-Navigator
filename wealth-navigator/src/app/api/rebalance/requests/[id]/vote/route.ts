import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { type RebalanceVote, tallyVotes } from "@/lib/rebalance/ic-vote";
import { type CommitteeEnvironment, governanceFor, requiredYes } from "@/lib/research-ic/governance";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/requests/[id]/vote
 *
 * Cast an IC vote (yes / no / abstain) on a rebalance proposal. Upserted per
 * (request_id, voter_email) so a committee member can revise their vote.
 *
 * When the YES votes cross the committee threshold (majority of 3 → ≥ 2 yes;
 * see src/lib/rebalance/ic-vote.ts + lib/research-ic/committee.ts) and the
 * proposal is still `pending`, it is promoted to `ic_approved` in the same
 * call — this is the gate the meeting asked for: nothing reaches the order
 * book without a majority vote.
 *
 * Gate chain (all required):
 *   1. signed-in admin
 *   2. `rebalance.approve_rebalance` granular permission (voting IS the
 *      approval mechanism, so no new grant needed)
 *   3. voter_email is on the IC whitelist (committee_member_c with the same
 *      fallback semantics as the research note vote route).
 */

export const dynamic = "force-dynamic";

const VALID_VOTES = ["yes", "no", "abstain"] as const;
type VoteValue = (typeof VALID_VOTES)[number];

const MIGRATION_HINT = "rebalance_vote_c table not migrated yet — apply 20260713000001_rebalance_vote_c.sql.";

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!canResearchIc(auth.ctx, "rebalance", "approve_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const vote = body.vote;
  if (typeof vote !== "string" || !VALID_VOTES.includes(vote as VoteValue)) {
    return NextResponse.json(
      { ok: false, error: `vote must be one of: ${VALID_VOTES.join(", ")}` },
      { status: 400 },
    );
  }
  const rationale = typeof body.rationale === "string" ? body.rationale.slice(0, 2000) : null;

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  // The proposal must exist, and we need its current status to decide whether a
  // passing vote should promote it.
  const reqCheck = await db
    .from("rebalance_request_c")
    .select("id, status, environment_scope")
    .eq("id", id)
    .maybeSingle();
  if (reqCheck.error) {
    if (isSupabaseSchemaMissing(reqCheck.error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
          migration: "supabase/migrations/20260710000004_rebalance_request_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: reqCheck.error.message }, { status: 500 });
  }
  if (!reqCheck.data) {
    return NextResponse.json({ ok: false, error: "rebalance request not found" }, { status: 404 });
  }
  const currentStatus = String(reqCheck.data.status ?? "");
  const scope = (
    String(reqCheck.data.environment_scope ?? "live").toLowerCase() === "uat" ? "uat" : "live"
  ) as CommitteeEnvironment;
  let governance: Awaited<ReturnType<typeof governanceFor>>;
  try {
    governance = await governanceFor(scope);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `IC governance is not configured: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 503 },
    );
  }
  const voter = governance.members.find(
    (m) => m.voter_email.toLowerCase() === auth.ctx.email.toLowerCase() && m.vote_scope.includes("rebalance"),
  );
  if (!voter)
    return NextResponse.json(
      { ok: false, error: `You are not an active ${scope.toUpperCase()} rebalance voter.` },
      { status: 403 },
    );

  const upsert = await db
    .from("rebalance_vote_c")
    .upsert(
      {
        request_id: id,
        voter_email: auth.ctx.email,
        vote,
        rationale,
        voted_at: new Date().toISOString(),
      },
      { onConflict: "request_id,voter_email" },
    )
    .select()
    .maybeSingle();
  if (upsert.error) {
    if (isSupabaseSchemaMissing(upsert.error)) {
      return NextResponse.json(
        {
          ok: false,
          error: MIGRATION_HINT,
          migration: "supabase/migrations/20260713000001_rebalance_vote_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: upsert.error.message }, { status: 500 });
  }

  // Recompute the tally from all votes and promote if the gate is crossed.
  const allVotes = await db
    .from("rebalance_vote_c")
    .select("voter_email, vote, voted_at")
    .eq("request_id", id);
  if (allVotes.error) {
    return NextResponse.json({ ok: false, error: allVotes.error.message }, { status: 500 });
  }
  const votes = (allVotes.data ?? []) as RebalanceVote[];
  const eligible = governance.members.filter((m) => m.vote_scope.includes("rebalance"));
  const eligibleEmails = new Set(eligible.map((m) => m.voter_email.toLowerCase()));
  const tally = tallyVotes(
    votes.filter((v) => eligibleEmails.has(v.voter_email.toLowerCase())),
    eligible.length,
    requiredYes(governance.policy, eligible.length) / Math.max(1, eligible.length),
  );

  let promoted = false;
  let status = currentStatus;
  // Only a still-open (pending) proposal is auto-promoted. We never auto-demote:
  // once approved, revising a vote below the threshold does not undo the decision.
  if (currentStatus === "pending" && tally.passed) {
    const upd = await db
      .from("rebalance_request_c")
      .update({ status: "ic_approved", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, status")
      .maybeSingle();
    if (!upd.error && upd.data) {
      promoted = true;
      status = String(upd.data.status ?? "ic_approved");
    }
  }

  return NextResponse.json(
    { ok: true, vote: upsert.data, votes, tally, promoted, status, environment_scope: scope },
    { status: 201 },
  );
}
