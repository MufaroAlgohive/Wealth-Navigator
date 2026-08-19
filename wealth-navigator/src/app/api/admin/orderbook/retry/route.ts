/**
 * POST /api/admin/orderbook/retry
 *
 * Retries a REJECTED (or FAILED) order: parks a brand-new
 * `oems_order_audit` row with the same symbol/side/qty/price/client
 * attribution as the original, via `parkOrder()` — the exact same
 * zero-broker-contact path `client-order/route.ts` uses. It does NOT
 * resend to IRESS itself; the new row sits on the Active Orderbook as
 * PARKED and the desk releases it via the normal "Send to Market" click,
 * same human-in-the-loop gate every other parked order goes through.
 *
 * Why a new row instead of resurrecting the old one: the old row is the
 * broker's record of what happened (including the reject reason) — audit
 * history must not be mutated. `retry_of` on the payload links the new
 * row back to it for traceability.
 *
 * Body: { order_audit_id: string }
 * Returns: { ok, orderAuditId?, orderId?, error? }
 *
 * Auth: admin session + `orderbook.send_to_market` — same permission as
 * every other send-to-broker-adjacent action (cancel-parked, release).
 */

import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { openSupabaseClients, parkOrder } from "@/lib/orders";
import type { OrderSide, OrderSource } from "@/lib/orders/types";

export const dynamic = "force-dynamic";

const RETRYABLE_STATES = new Set(["rejected", "failed"]);

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

  let supabase;
  try {
    supabase = await openSupabaseClients();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Supabase not configured" },
      { status: 503 },
    );
  }

  const { data: row, error: readErr } = await supabase.institutional
    .from("oems_order_audit")
    .select(
      "id, order_id, symbol, side, quantity, price_cents, broker_account_code, source, client_account, status, payload",
    )
    .eq("id", auditId)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: `No order found for id=${auditId}` }, { status: 404 });
  }
  if (!RETRYABLE_STATES.has(String(row.status))) {
    return NextResponse.json(
      {
        ok: false,
        error: `Cannot retry — order status is '${row.status}', not rejected/failed. Only a rejected or failed order can be retried.`,
      },
      { status: 409 },
    );
  }

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const accountCode = (row.broker_account_code as string) ?? (payload.broker_account_code as string) ?? "";
  if (!accountCode) {
    return NextResponse.json(
      { ok: false, error: "Original order has no broker_account_code — cannot rebuild a retry." },
      { status: 422 },
    );
  }

  const result = await parkOrder(
    supabase,
    {
      account_code: accountCode,
      symbol: row.symbol as string,
      side: row.side as OrderSide,
      qty: row.quantity as number,
      price_cents: row.price_cents as number | null,
      source: (row.source as OrderSource) ?? "MINT_CLIENT_ORDER",
      order_type: (payload.order_type as "market" | "limit") ?? "market",
      trader_email: (payload.trader as string) ?? (payload.sent_by as string) ?? "retry@system",
      client_account: (row.client_account as string) ?? null,
      holding_id: (payload.holding_id as string) ?? null,
      family_member_id: (payload.family_member_id as string) ?? null,
      user_id: (payload.user_id as string) ?? null,
    },
    {
      bookId: (payload.book_id as string) ?? undefined,
      broker: (payload.broker as string) ?? undefined,
      uatTest: payload.uat_test === true,
    },
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error ?? "failed to park retry order" }, { status: 500 });
  }

  // Link the new row back to the one it retries, for traceability — best
  // effort, doesn't block the retry succeeding if this update fails. Reads
  // the payload parkOrder just wrote so this merges into it rather than
  // clobbering it.
  if (result.order_audit_id) {
    const { data: fresh } = await supabase.institutional
      .from("oems_order_audit")
      .select("payload")
      .eq("id", result.order_audit_id)
      .maybeSingle();
    const merged = {
      ...((fresh?.payload as Record<string, unknown>) ?? {}),
      retry_of: auditId,
      retry_of_order_id: row.order_id,
    };
    await supabase.institutional.from("oems_order_audit").update({ payload: merged }).eq("id", result.order_audit_id);
  }

  return NextResponse.json({
    ok: true,
    orderAuditId: result.order_audit_id,
    orderId: result.order_id,
    status: "parked",
    notice: "Retry parked on the order book — awaiting Send to Market release.",
  });
}
