import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { requireMasterPassword } from "@/lib/admin/step-up";
import { maybeCompleteRebalance } from "@/lib/rebalance/complete-rebalance";
import { settleRebalanceCashForClients } from "@/lib/rebalance/settle-rebalance-cash";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";
import { observedFillFromAudit, settleFill } from "@workers/iress-ingest/src/settlement";

/**
 * POST /api/admin/orderbook/manual-fill
 *
 * Emergency manual fill for when IRESS itself is unreachable — the desk has
 * a broker confirmation (paper, phone, whatever reaches them) for an order
 * that genuinely filled, but the automated poll that would normally observe
 * and settle it has nothing to poll. This writes that fill in by hand.
 *
 * There is no broker confirmation behind this call — the price came from
 * whatever the operator uploaded or typed. That is why it is gated on the
 * SAME Master ★ tier as "Send to Market" (requireMasterPassword — the
 * password re-entry itself was already removed there 2026-08-17; the tier
 * check is what remains and is unchanged here), not a lesser permission.
 *
 * Settlement itself goes through settleFill — the SAME real engine used for
 * genuine IRESS-observed fills (workers/iress-ingest/src/settlement.ts),
 * not a simplified mock. That's deliberate: this order is exactly as real
 * as one the worker would have observed, so it gets exactly the same lot
 * FIFO/wallet/reserve mechanics, live or UAT alike. No uat_test branching
 * here — that gate exists elsewhere (parkOrder/submitOrder) to keep a UAT
 * order OFF the broker in the first place; this route only ever runs after
 * an order already exists, and settleFill treats both lanes identically.
 *
 * Body: { order_audit_id: string, fill_price_cents: number }
 * Returns: { ok, status?, error? }
 */

export const dynamic = "force-dynamic";

const NON_FILLABLE = new Set(["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "FAILED", "filled", "cancelled", "rejected", "expired", "failed"]);

export async function POST(req: Request) {
  const stepUp = await requireMasterPassword(undefined);
  if (!stepUp.ok) {
    return NextResponse.json({ ok: false, error: stepUp.error }, { status: stepUp.status });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const auditId = typeof body.order_audit_id === "string" ? body.order_audit_id.trim() : "";
  const fillPriceCents = Math.round(Number(body.fill_price_cents));
  if (!auditId) {
    return NextResponse.json({ ok: false, error: "order_audit_id is required" }, { status: 400 });
  }
  if (!Number.isFinite(fillPriceCents) || fillPriceCents <= 0) {
    return NextResponse.json({ ok: false, error: "fill_price_cents must be a positive number" }, { status: 400 });
  }

  let institutionalDb: SupabaseClient;
  let retailDb: SupabaseClient;
  try {
    institutionalDb = createInstitutionalServiceRoleClient();
    retailDb = createRetailServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Supabase not configured" },
      { status: 503 },
    );
  }

  const { data: row, error: readErr } = await institutionalDb
    .from("oems_order_audit")
    .select("id, order_id, symbol, side, quantity, status, payload, result_payload")
    .eq("id", auditId)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: `No order found for id=${auditId}` }, { status: 404 });
  }
  if (NON_FILLABLE.has(String(row.status))) {
    return NextResponse.json(
      { ok: false, error: `Cannot fill — order status is already terminal (${row.status}).` },
      { status: 409 },
    );
  }

  const qty = Number(row.quantity) || 0;
  if (qty <= 0) {
    return NextResponse.json({ ok: false, error: "Order has no quantity to fill." }, { status: 422 });
  }

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const resultPayload = (row.result_payload ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();

  // Same shape the automated fills route builds before handing off to
  // settlement — filled/avgPx are CENTS by the same convention everywhere
  // else in this codebase reads them (execution/route.ts, order-books/route.ts).
  const updatedPayload: Record<string, unknown> = {
    ...payload,
    filled: qty,
    avgPx: fillPriceCents,
    lastFillAt: now,
  };
  const rebalanceRequestId =
    typeof payload.rebalance_request_id === "string" && payload.rebalance_request_id ? payload.rebalance_request_id : null;

  const fill = observedFillFromAudit({
    order_id: row.order_id,
    symbol: row.symbol,
    side: row.side,
    status: "filled",
    quantity: row.quantity,
    payload: updatedPayload,
  });
  if (!fill) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Could not derive a settleable fill from this order — it may be missing client attribution (user_id) or a security_id.",
      },
      { status: 422 },
    );
  }
  // A rebalance sell's proceeds fund the rebalance's own buys, not a wallet
  // withdrawal — same rule the automated sell-settlement path applies. The
  // real cash bridge runs once via settleRebalanceCashForClients below, after
  // every leg of the rebalance has actually finished.
  if (fill.side === "sell" && rebalanceRequestId) {
    fill.skipCashMovement = true;
  }

  const settlement = await settleFill(
    { institutional: institutionalDb, retail: retailDb, enabled: true, dryRun: false },
    fill,
  );
  if (!settlement.applied) {
    return NextResponse.json(
      { ok: false, error: settlement.error ?? "Settlement did not apply." },
      { status: 422 },
    );
  }

  const { error: updErr } = await institutionalDb
    .from("oems_order_audit")
    .update({
      status: "filled",
      payload: updatedPayload,
      result_payload: {
        ...resultPayload,
        avgFillPrice: fillPriceCents,
        manual_fill: true,
        manual_fill_by: stepUp.email,
        manual_fill_at: now,
        manual_fill_reason: "IRESS unavailable — emergency manual fill",
      },
      updated_at: now,
    })
    .eq("id", auditId);
  if (updErr) {
    // Money has already moved via settleFill above — the audit row not
    // reflecting "filled" is a display problem, not a financial one, and
    // must be surfaced rather than silently left inconsistent.
    return NextResponse.json(
      { ok: false, error: `Fill settled, but the order record failed to update: ${updErr.message}` },
      { status: 500 },
    );
  }

  // Same completion check the automated fills route runs: a fill that
  // finishes off every order booked for a rebalance is the moment the
  // strategy's model composition flips and each client's cash economics
  // settle.
  let completion = null;
  if (rebalanceRequestId) {
    const outcome = await maybeCompleteRebalance(retailDb, institutionalDb, rebalanceRequestId, stepUp.email);
    const cash = outcome.completed
      ? await settleRebalanceCashForClients(retailDb, institutionalDb, rebalanceRequestId, outcome.settlementBatchId)
      : null;
    completion = { rebalance_request_id: rebalanceRequestId, ...outcome, cashSettlement: cash };
  }

  return NextResponse.json({
    ok: true,
    status: "filled",
    fill_price_cents: fillPriceCents,
    ...(completion ? { rebalance_completion: completion } : {}),
  });
}
