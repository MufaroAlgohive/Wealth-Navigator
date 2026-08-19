import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { executeRebalanceRequest } from "@/lib/rebalance/execute-rebalance-request";
import { type RebalanceVote, tallyVotes } from "@/lib/rebalance/ic-vote";
import { type CommitteeEnvironment, governanceFor, requiredYes } from "@/lib/research-ic/governance";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/requests/[id]/transition
 *
 * Advance a rebalance request through the IC gate:
 *
 *   pending      → ic_approved | rejected   (requires `rebalance.approve_rebalance`)
 *   pending      → cancelled                (requester or dev)
 *   ic_approved  → executed                 (requires `rebalance.approve_rebalance`) — "Send to Order Book"
 *   ic_approved  → cancelled                (requester or dev)
 *
 * `ic_approved` is a pure decision — nothing is written anywhere yet, so an
 * admin can see exactly what's about to change (on the Rebalances tab) before
 * committing to it. `executed` is the actual "Send to Order Book" action: this
 * is the one moment parked clients' holdings get repositioned and settled
 * clients get their delta orders booked (see reconcileParkedHoldings /
 * bookSettledRebalanceOrders below) — real broker dispatch from there is a
 * separate, still-disabled step (requests/[id]/push/route.ts).
 *
 * Body: `{ to_status: "ic_approved" | "executed" | "rejected" | "cancelled", reason?: string }`.
 */

export const dynamic = "force-dynamic";

const ALLOWED: Record<string, ReadonlyArray<string>> = {
  pending: ["ic_approved", "rejected", "cancelled"],
  ic_approved: ["executed", "cancelled"],
  rejected: [],
  executed: [],
  cancelled: [],
};

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

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const toStatus = typeof body.to_status === "string" ? body.to_status : "";
  if (!toStatus || !["ic_approved", "executed", "rejected", "cancelled"].includes(toStatus)) {
    return NextResponse.json(
      { ok: false, error: "to_status must be one of: ic_approved, executed, rejected, cancelled" },
      { status: 400 },
    );
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const { data: request, error: reqErr } = await db
    .from("rebalance_request_c")
    .select(
      "id, status, requested_by, strategy_id, current_composition, proposed_composition, affected_investors, environment_scope",
    )
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    if (isSupabaseSchemaMissing(reqErr)) {
      return NextResponse.json(
        {
          ok: false,
          error: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
          migration: "supabase/migrations/20260710000004_rebalance_request_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: reqErr.message }, { status: 500 });
  }
  if (!request)
    return NextResponse.json({ ok: false, error: "rebalance request not found" }, { status: 404 });

  const from = request.status as string;
  const allowed = ALLOWED[from] ?? [];
  if (!allowed.includes(toStatus)) {
    return NextResponse.json(
      { ok: false, error: `illegal transition: ${from} → ${toStatus}` },
      { status: 409 },
    );
  }

  // ic_approved / executed / rejected are IC/desk decisions — gated on the
  // approve permission. cancelled can be done by the requester (or dev) to
  // withdraw their own draft, OR by anyone who could have approved it —
  // once a proposal is already ic_approved, aborting it before it reaches
  // the order book is a desk decision, not just the original requester's.
  const isRequester = auth.ctx.email.toLowerCase() === String(request.requested_by ?? "").toLowerCase();
  const isDev = auth.ctx.approverTier === "dev";
  const canApprove = canResearchIc(auth.ctx, "rebalance", "approve_rebalance");
  if ((toStatus === "ic_approved" || toStatus === "executed" || toStatus === "rejected") && !canApprove) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // The committee majority is the actual gate on pending -> ic_approved, not
  // just the permission to click Approve. Until this check existed, having
  // `approve_rebalance` was enough on its own: /vote applies the same
  // tallyVotes() rule when a vote is cast, but this route — which every
  // "Approve" button in the UI ultimately calls, standalone or combined with
  // a research note — never consulted rebalance_vote_c at all. A single
  // approver could promote a proposal with zero votes cast, on any strategy,
  // by calling this endpoint directly; the UI's disabled state was cosmetic,
  // not enforcement. No UAT exception: a rebalance on a test strategy is a
  // real rehearsal of this exact gate, not a reason to skip it.
  if (from === "pending" && (toStatus === "ic_approved" || toStatus === "rejected")) {
    const votesRes = await db
      .from("rebalance_vote_c")
      .select("voter_email, vote, voted_at")
      .eq("request_id", id);
    if (votesRes.error) {
      return NextResponse.json({ ok: false, error: votesRes.error.message }, { status: 500 });
    }
    const scope = (
      String(request.environment_scope ?? "live").toLowerCase() === "uat" ? "uat" : "live"
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
    const eligible = governance.members.filter((m) => m.vote_scope.includes("rebalance"));
    const emails = new Set(eligible.map((m) => m.voter_email.toLowerCase()));
    const tally = tallyVotes(
      ((votesRes.data ?? []) as RebalanceVote[]).filter((v) => emails.has(v.voter_email.toLowerCase())),
      eligible.length,
      requiredYes(governance.policy, eligible.length) / Math.max(1, eligible.length),
    );
    // A master/dev may explicitly bypass the ballot only when this environment
    // has enabled the manual rebalance override in IC Settings. The setting is
    // checked here at the write boundary; a UI button alone is not authority.
    if (toStatus === "ic_approved" && !governance.policy.manual_rebalance_decision_enabled && !tally.passed) {
      return NextResponse.json(
        {
          ok: false,
          error: `Committee majority not reached: ${tally.yes} of ${tally.requiredYes} required yes votes.`,
        },
        { status: 409 },
      );
    }
    if (toStatus === "rejected" && !governance.policy.manual_rebalance_decision_enabled) {
      return NextResponse.json(
        { ok: false, error: "Manual rebalance override is disabled for this environment; reject through the committee vote." },
        { status: 409 },
      );
    }
  }
  if (toStatus === "cancelled" && !isRequester && !isDev && !(from === "ic_approved" && canApprove)) {
    return NextResponse.json(
      { ok: false, error: "only the requester may cancel this proposal" },
      { status: 403 },
    );
  }

  // Compare-and-swap, not a blind write: two concurrent clicks (two admins,
  // or one impatient double-click) can both read the same `from` state and
  // both pass every check above before either write lands. Without this
  // guard both writes apply — and if toStatus is "executed", that means
  // reconcileParkedHoldings/bookSettledRebalanceOrders would run TWICE,
  // double-booking every order in the rebalance. `.eq("status", from)` makes
  // the second writer's update match zero rows instead.
  const { data, error } = await db
    .from("rebalance_request_c")
    .update({
      status: toStatus,
      updated_at: new Date().toISOString(),
      ...(toStatus === "executed" ? { executed_at: new Date().toISOString() } : {}),
    })
    .eq("id", id)
    .eq("status", from)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json(
      {
        ok: false,
        error: "This proposal's status changed since you loaded it — someone else already acted on it. Refresh and try again.",
      },
      { status: 409 },
    );
  }

  // "Send to Order Book" (ic_approved -> executed) is the one moment this
  // rebalance actually touches anything — see executeRebalanceRequest's
  // docstring. Best-effort: a failure here doesn't block the transition
  // itself, it's just reported.
  let parked: { reconciledUserIds: string[]; errors: string[] } | null = null;
  let booked: { bookedUserIds: string[]; errors: string[] } | null = null;
  if (toStatus === "executed") {
    const retailDb = createRetailServiceRoleClient();
    const result = await executeRebalanceRequest(retailDb, db, {
      id: request.id as string,
      strategy_id: request.strategy_id as string | null,
      current_composition: request.current_composition,
      proposed_composition: request.proposed_composition,
      affected_investors: request.affected_investors,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
    }
    parked = result.parked;
    booked = result.booked;
  }

  return NextResponse.json({ ok: true, request: data, parked, booked });
}
