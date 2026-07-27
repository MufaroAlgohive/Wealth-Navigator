/**
 * POST /api/admin/orderbook/uat-order
 *
 * Ad-hoc single-order UAT tester. Thin wrapper around `submitOrder()` from
 * the core `src/lib/orders/` module — the same helper every other order
 * entry point uses, so the preflight + audit + worker fanout + force-
 * correction contract is shared.
 *
 * Body: { symbol: string, side: "buy" | "sell", qty: number, price?: number }
 *   - `price` is in RANDS (limit); omit/0 for a market order.
 * Returns: { ok, orderAuditId, orderId, bookId, mode, iressOrderNumber?, status?, preflight?, error? }
 *
 * Gated: admin + orderbook.send_to_market, and IRESS_UAT_MODE=1|true (never
 * touches the production account; the worker enforces the UAT account).
 *
 * Force-correction contract (2026-07-20):
 *   - A blocked preflight returns `422` with `{ ok: false, preflight }` and
 *     writes NO audit row. The trader stays on the entry screen, edits
 *     qty/price, and resubmits.
 *   - A post-insert worker rejection (race window where another order
 *     lands between preflight and submit) stamps the audit row `rejected`
 *     and returns `200 { ok: false, error, worker_code, order_audit_id }`
 *     so the operator sees the truth.
 *
 * See plan §2 (BFF routes → thin wrappers) for the rationale.
 */

import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { uatModeEnabled } from "@/lib/oems/uat-scope";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { openSupabaseClients, preflight, submitOrder } from "@/lib/orders";
import type { SubmitResult } from "@/lib/orders";

export const dynamic = "force-dynamic";

const BOOK_ID = "UAT-ADHOC";
// UAT orders route to the LONGMARK CARE destination (-> EXT_BROKERTI), per IRESS
// (Andre, 2026-07-13, connecting the LONGMARK CARE session).
// IRESS_UAT_DESTINATION overrides without a redeploy.
const BROKER = process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // Accepts "1" as well as "true" — see uatModeEnabled().
  if (!uatModeEnabled()) {
    return NextResponse.json({ ok: false, error: "IRESS_UAT_MODE is not enabled." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawSymbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Math.floor(Number(body.qty));
  const priceRaw = body.price == null || body.price === "" ? null : Number(body.price);
  // Convert Rands → cents for the core `submitOrder` contract.
  const priceCents =
    priceRaw != null && Number.isFinite(priceRaw) && priceRaw > 0 ? Math.round(priceRaw * 100) : null;

  if (!rawSymbol) {
    return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ ok: false, error: "qty must be a positive integer" }, { status: 400 });
  }

  // Preflight explicitly so we can return the worker's exact preflight
  // payload (vs the synthetic 503 the core module returns when the worker
  // is offline). This matches the legacy contract where the BFF surfaced
  // the worker's `naked_short_blocked` reason verbatim.
  const pre = await preflight({
    account_code: BROKER,
    symbol: rawSymbol,
    side,
    qty,
    price_cents: priceCents,
    source: "UAT_ADHOC_ORDER",
    book_id: BOOK_ID,
  });
  if (!pre.ok) {
    // NO AUDIT ROW WRITTEN. Trader stays on the entry screen. The UI
    // opens `<GuardrailForceCorrectionDialog/>` with `pre` as the payload.
    return NextResponse.json(
      {
        ok: false,
        bookId: BOOK_ID,
        mode: "uat",
        status: "blocked",
        code: pre.code,
        error: pre.message,
        preflight: pre,
      },
      { status: 422 },
    );
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

  const result: SubmitResult = await submitOrder(
    supabase,
    {
      account_code: BROKER,
      symbol: rawSymbol,
      side,
      qty,
      price_cents: priceCents,
      source: "UAT_ADHOC_ORDER",
      book_id: BOOK_ID,
      trader_email: auth.ctx.email,
    },
    { bookId: BOOK_ID, broker: BROKER, uatTest: true },
  );

  if (!result.ok && !result.order_audit_id) {
    // Defense in depth — the explicit preflight above already passed,
    // but if `submitOrder` re-rejected (e.g. local fallback when worker
    // offline), bubble the same shape.
    return NextResponse.json(
      {
        ok: false,
        bookId: BOOK_ID,
        mode: "uat",
        status: "blocked",
        code: result.preflight.code,
        error: result.preflight.message,
        preflight: result.preflight,
      },
      { status: 422 },
    );
  }

  // Audit-only fallback (worker not configured) → return the same
  // `mode: "audit-only"` shape the legacy route used, for UI continuity.
  if (result.ok && !result.iress_order_number && !isIressWorkerConfigured()) {
    return NextResponse.json({
      ok: true,
      orderAuditId: result.order_audit_id,
      orderId: result.order_id,
      bookId: BOOK_ID,
      mode: "audit-only",
      notice: "IRESS_WORKER_URL not configured on Vercel; order recorded, not sent to IRESS.",
    });
  }

  if (!result.ok) {
    // Worker rejected AFTER the audit row was inserted (race condition).
    // `submitOrder` already stamped the row `rejected`; we just relay.
    return NextResponse.json({
      ok: false,
      orderAuditId: result.order_audit_id,
      orderId: result.order_id,
      bookId: BOOK_ID,
      mode: "uat",
      status: "rejected",
      error: result.error ?? "unknown worker error",
      code: result.worker_code,
      preflight: result.preflight,
    });
  }

  return NextResponse.json({
    ok: true,
    orderAuditId: result.order_audit_id,
    orderId: result.order_id,
    bookId: BOOK_ID,
    mode: "uat",
    iressOrderNumber: result.iress_order_number ?? null,
    status: result.status ?? "working",
    preflight: result.preflight,
  });
}
