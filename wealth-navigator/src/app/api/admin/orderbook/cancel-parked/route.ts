/**
 * POST /api/admin/orderbook/cancel-parked
 *
 * Cancels a PARKED order — one that has never left our system at all
 * (zero broker/worker contact, written by client-order/route.ts and
 * awaiting a "Send to Market" release). Unlike `/orders/cancel` (which
 * forwards a real OrderDelete to IRESS via the worker for an order
 * already on the broker's book), this is a pure local update: flip the
 * row's status to `cancelled` directly, no worker round-trip.
 *
 * Exists so a wrong order — wrong ticker, wrong qty, fat-fingered on the
 * app — can be killed before it's ever released, especially now that
 * real (allowlisted) production accounts can park orders through
 * client-order/route.ts, not just test accounts.
 *
 * Fails closed on a race: if the row is no longer `parked` by the time
 * this runs (an admin already released it, or it was already cancelled),
 * refuse with 409 rather than silently no-op or, worse, cancel something
 * that may already be working at the broker.
 *
 * Body: { order_audit_id: string }
 * Returns: { ok, status? , error? }
 *
 * Auth: admin session + `orderbook.send_to_market` — the same permission
 * every other send-to-broker action already requires.
 */

import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const auditId = typeof body.order_audit_id === "string" ? body.order_audit_id.trim() : "";
  if (!auditId) {
    return NextResponse.json({ ok: false, error: "order_audit_id is required" }, { status: 400 });
  }

  let db;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Supabase not configured" },
      { status: 503 },
    );
  }

  const { data: row, error: readErr } = await db
    .from("oems_order_audit")
    .select("id, status, payload, result_payload")
    .eq("id", auditId)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: `No order found for id=${auditId}` }, { status: 404 });
  }
  if (row.status !== "parked") {
    return NextResponse.json(
      {
        ok: false,
        error: `Cannot cancel — order is no longer parked (current status: ${row.status}). It may already have been released or cancelled.`,
      },
      { status: 409 },
    );
  }

  // A rebalance-sourced order's parent request stays "executed" regardless
  // of what happens to the individual orders it spawned — that transition
  // never reverts, so there's nothing to "undo" here. Best this route can do
  // is make the cancellation traceable: anyone auditing the rebalance later
  // (querying rebalance_request_id) can see this order was explicitly killed
  // rather than assuming a gap in stock_holdings_c means a missed fill.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const rebalanceRequestId = typeof payload.rebalance_request_id === "string" ? payload.rebalance_request_id : null;
  const resultPayload = (row.result_payload ?? {}) as Record<string, unknown>;

  const { error: updErr } = await db
    .from("oems_order_audit")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
      result_payload: rebalanceRequestId
        ? {
            ...resultPayload,
            cancelled_from_rebalance_request_id: rebalanceRequestId,
            cancelled_by: auth.ctx.email,
            cancelled_at: new Date().toISOString(),
          }
        : resultPayload,
    })
    .eq("id", auditId);
  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status: "cancelled", rebalance_request_id: rebalanceRequestId });
}
