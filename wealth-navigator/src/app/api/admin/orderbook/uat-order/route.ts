/**
 * POST /api/admin/orderbook/uat-order
 *
 * Ad-hoc single-order UAT tester. It parks an internal audit row which can
 * only be completed through the OEM's local Fill (UAT) action.
 *
 * Body: { symbol: string, side: "buy" | "sell", qty: number, price?: number }
 *   - `price` is in RANDS (limit); omit/0 for a market order.
 * Returns: { ok, orderAuditId, orderId, bookId, mode, iressOrderNumber?, status?, preflight?, error? }
 *
 * Gated by admin permission and profiles.is_test=true. The shared UAT guard
 * blocks worker, IRESS, and LONGMARK fanout regardless of environment.
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
import { openSupabaseClients, submitOrder } from "@/lib/orders";
import type { SubmitResult } from "@/lib/orders";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const BOOK_ID = "UAT-ADHOC";
// Internal marker only. UAT orders are parked and self-filled; this value is
// never passed to the worker, IRESS, or LONGMARK.
const UAT_ACCOUNT = "UAT_SELF_FILL";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
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
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Select a UAT test client." }, { status: 400 });
  }

  let clientAccount = userId;
  try {
    const retail = createRetailServiceRoleClient();
    const { data: profile, error } = await retail
      .from("profiles")
      .select("id,email,is_test")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!profile || profile.is_test !== true) {
      return NextResponse.json(
        { ok: false, error: "UAT orders are restricted to test clients." },
        { status: 403 },
      );
    }
    clientAccount = profile.email ?? userId;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `Could not verify UAT client: ${error instanceof Error ? error.message : String(error)}` },
      { status: 503 },
    );
  }

  // No broker preflight for UAT. UAT never contacts IRESS/the worker at all —
  // it self-fills in the OEM (see uat-guard.ts). submitOrder parks the order
  // with zero broker contact; the desk fills it via the Fill (UAT) button.
  let supabase: Awaited<ReturnType<typeof openSupabaseClients>>;
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
      account_code: UAT_ACCOUNT,
      symbol: rawSymbol,
      side,
      qty,
      price_cents: priceCents,
      source: "UAT_ADHOC_ORDER",
      book_id: BOOK_ID,
      user_id: userId,
      client_account: clientAccount,
      trader_email: auth.ctx.email,
    },
    { bookId: BOOK_ID, broker: UAT_ACCOUNT, uatTest: true },
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
    mode: "uat-self-fill",
    iressOrderNumber: null,
    status: result.status ?? "parked",
    notice: "UAT self-fill only. This order cannot be released to IRESS or LONGMARK.",
    preflight: result.preflight,
  });
}
