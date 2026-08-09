import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
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
 *   ic_approved  → cancelled                (requester or dev)
 *
 * This is the missing link between the Rebalance Builder ("Submit to IC" →
 * status='pending') and the push endpoint (which requires status='ic_approved'
 * before it will write orders). `executed` is reached only via the push route,
 * never here.
 *
 * Body: `{ to_status: "ic_approved" | "rejected" | "cancelled", reason?: string }`.
 */

export const dynamic = "force-dynamic";

const ALLOWED: Record<string, ReadonlyArray<string>> = {
  pending: ["ic_approved", "rejected", "cancelled"],
  ic_approved: ["cancelled"],
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
  if (!toStatus || !["ic_approved", "rejected", "cancelled"].includes(toStatus)) {
    return NextResponse.json(
      { ok: false, error: "to_status must be one of: ic_approved, rejected, cancelled" },
      { status: 400 },
    );
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const { data: request, error: reqErr } = await db
    .from("rebalance_request_c")
    .select("id, status, requested_by, strategy_id, current_composition, proposed_composition")
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

  // ic_approved / rejected are IC decisions — gated on the approve permission.
  // cancelled can be done by the requester (or dev) to withdraw their own proposal.
  const isRequester = auth.ctx.email.toLowerCase() === String(request.requested_by ?? "").toLowerCase();
  const isDev = auth.ctx.approverTier === "dev";
  if (
    (toStatus === "ic_approved" || toStatus === "rejected") &&
    !can(auth.ctx, "rebalance", "approve_rebalance")
  ) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (toStatus === "cancelled" && !isRequester && !isDev) {
    return NextResponse.json(
      { ok: false, error: "only the requester may cancel this proposal" },
      { status: 403 },
    );
  }

  const { data, error } = await db
    .from("rebalance_request_c")
    .update({ status: toStatus, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // IC approval is the point this rebalance becomes a real decision — even
  // though real broker dispatch is a separate, still-disabled step (see
  // requests/[id]/push/route.ts), any client whose buy into this strategy
  // hasn't been sent to the broker yet should stop being stale the moment
  // the decision is made, not wait for execution to land. Best-effort: a
  // failure here doesn't block the IC transition itself, it's just reported.
  let parked: { reconciledUserIds: string[]; errors: string[] } | null = null;
  let booked: { bookedUserIds: string[]; errors: string[] } | null = null;
  if (toStatus === "ic_approved" && request.strategy_id) {
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
      .select("id")
      .eq("name", strategyName)
      .maybeSingle();
    const resolvedStrategyId = (strategyRes.data?.id as string) ?? "";
    const currentComposition = Array.isArray(request.current_composition) ? request.current_composition : [];
    const proposedComposition = Array.isArray(request.proposed_composition)
      ? request.proposed_composition
      : [];

    try {
      parked = await reconcileParkedHoldings(
        retailDb,
        db,
        resolvedStrategyId,
        strategyName,
        currentComposition,
        proposedComposition,
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
      );
    } catch (err) {
      booked = { bookedUserIds: [], errors: [err instanceof Error ? err.message : String(err)] };
    }
  }

  return NextResponse.json({ ok: true, request: data, parked, booked });
}
