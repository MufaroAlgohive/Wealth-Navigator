import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { bookSettledRebalanceOrders } from "@/lib/rebalance/book-settled-rebalance-orders";
import { reconcileParkedHoldings } from "@/lib/rebalance/reconcile-parked-holdings";
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
      "id, status, requested_by, strategy_id, current_composition, proposed_composition, affected_investors",
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
  if (toStatus === "cancelled" && !isRequester && !isDev && !(from === "ic_approved" && canApprove)) {
    return NextResponse.json(
      { ok: false, error: "only the requester may cancel this proposal" },
      { status: 403 },
    );
  }

  const { data, error } = await db
    .from("rebalance_request_c")
    .update({
      status: toStatus,
      updated_at: new Date().toISOString(),
      ...(toStatus === "executed" ? { executed_at: new Date().toISOString() } : {}),
    })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // "Send to Order Book" (ic_approved -> executed) is the one moment this
  // rebalance actually touches anything — any client whose buy into this
  // strategy hasn't been sent to the broker yet gets repositioned for free,
  // and settled clients get their delta orders booked. Best-effort: a
  // failure here doesn't block the transition itself, it's just reported.
  let parked: { reconciledUserIds: string[]; errors: string[] } | null = null;
  let booked: { bookedUserIds: string[]; errors: string[] } | null = null;
  if (toStatus === "executed" && request.strategy_id) {
    // rebalance_request_c.strategy_id actually stores the strategy's
    // display NAME (see rebalance-builder-page.tsx::submitToIc), not its
    // real id — stock_holdings_c.strategy_id is the real id. Resolve it so
    // neither query below ends up comparing a name against a UUID column
    // (which always returns zero rows, silently no-op'ing this whole
    // feature — caught via a real approval producing no reconciled clients
    // despite genuinely parked holdings existing).
    const retailDb = createRetailServiceRoleClient();
    const strategyName = request.strategy_id as string;
    const strategyRes = await retailDb
      .from("strategies_c")
      .select("id, investor_environment")
      .eq("name", strategyName)
      .maybeSingle();
    const resolvedStrategyId = (strategyRes.data?.id as string) ?? "";
    // Drives the uat_test tag and broker destination on every order booked
    // below — a UAT/test strategy's orders must show under "UAT orders" on
    // Active Orderbook regardless of this deployment's own env flag.
    const isUatStrategy = String(strategyRes.data?.investor_environment ?? "").toUpperCase() === "UAT";
    const currentComposition = Array.isArray(request.current_composition) ? request.current_composition : [];
    const proposedComposition = Array.isArray(request.proposed_composition)
      ? request.proposed_composition
      : [];

    // A "single_user" request carries ONE client's own target quantities, not
    // a model template. Both booking passes below normally fan the proposed
    // composition out across every investor in the strategy, which for this
    // scope would rewrite everyone else's orders to one account's numbers — so
    // they get confined to that account. Completion is likewise scoped: see
    // maybeCompleteRebalance, which skips the model flip and return boundary
    // entirely for this scope, because the strategy itself does not change.
    const affected = request.affected_investors as { scope?: unknown; user_id?: unknown } | null;
    const isSingleUser = affected?.scope === "single_user";
    const singleUserId = typeof affected?.user_id === "string" ? affected.user_id : "";
    if (isSingleUser && !singleUserId) {
      return NextResponse.json(
        { ok: false, error: "single_user rebalance is missing affected_investors.user_id" },
        { status: 422 },
      );
    }
    const restrictToUserId = isSingleUser ? singleUserId : undefined;

    try {
      parked = await reconcileParkedHoldings(
        retailDb,
        db,
        resolvedStrategyId,
        strategyName,
        currentComposition,
        proposedComposition,
        id,
        isUatStrategy,
        restrictToUserId,
      );
    } catch (err) {
      parked = { reconciledUserIds: [], errors: [err instanceof Error ? err.message : String(err)] };
    }

    // Settled (already-filled) clients don't get their holdings touched at
    // approval time — only a real fill can change what they hold. This
    // books the parked delta orders (+1/-5 etc.) the desk reviews on the
    // UAT order book instead.
    try {
      booked = await bookSettledRebalanceOrders(
        retailDb,
        db,
        resolvedStrategyId,
        strategyName,
        currentComposition,
        proposedComposition,
        id,
        isUatStrategy,
        restrictToUserId,
      );
    } catch (err) {
      booked = { bookedUserIds: [], errors: [err instanceof Error ? err.message : String(err)] };
    }
  }

  return NextResponse.json({ ok: true, request: data, parked, booked });
}
