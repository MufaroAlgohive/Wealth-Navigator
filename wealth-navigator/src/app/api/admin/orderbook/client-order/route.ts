/**
 * POST /api/admin/orderbook/client-order
 *
 * Server-to-server entry point for the MINT retail app: when a client buys
 * (Phase 1) or sells (later) a single security, mint calls this route so
 * the SAME order — same ticker, qty, price — that already gets written to
 * `stock_holdings_c` also gets forwarded through the exact worker pipeline
 * the admin UAT tools use. Thin wrapper around `submitOrder()`/`preflight()`
 * from `@/lib/orders`, same core the ad-hoc UAT ticket
 * (`uat-order/route.ts`) uses — not a parallel implementation.
 *
 * Body: {
 *   holding_id:    string,           // stock_holdings_c.id this order came from
 *   symbol:        string,
 *   side:          "buy" | "sell",
 *   qty:           number,
 *   price_cents?:  number | null,    // omit/null = market order
 *   client_email?: string,
 *   source_ref?:   string,           // mint's transaction id, for cross-system log tracing
 * }
 * Returns: { ok, orderAuditId, orderId, bookId, mode, iressOrderNumber?, status?, preflight?, error?, alreadyForwarded? }
 *
 * Auth: `Authorization: Bearer ${MINT_CLIENT_ORDER_SECRET}` (mint has no
 * admin browser session to present), OR an admin session as a fallback for
 * manual testing from the admin UI. Gated by `IRESS_UAT_MODE=true` like
 * every sibling UAT route — never touches the production account.
 *
 * UAT-only client guard: this is explicitly scoped to test/UAT accounts for
 * now — real clients' orders must never reach IRESS through this route.
 * mint is expected to check this itself before calling, but this route
 * independently re-verifies (fail-closed) that the holding's owning user is
 * a test account (`profiles.is_test` OR `wallets.status='test'`), mirroring
 * the same "CLIENT-DATA GUARD" pattern already used in
 * `send-to-market/route.ts` for the exact same risk.
 *
 * Idempotency: keyed on `payload->>holding_id` — a retried mint request for
 * the same holding is a no-op success (`alreadyForwarded: true`), not a
 * second order.
 */

import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { openSupabaseClients, preflight, submitOrder } from "@/lib/orders";
import type { SubmitResult } from "@/lib/orders";

export const dynamic = "force-dynamic";

// Fixed grouping label for every Phase-1 single-security client order — a UI
// label only (see `groupRowsByStrategy()`), not the real join key. The real
// join between a specific investor's specific position and its IRESS status
// is `payload.holding_id`. Superseded by the real strategy name once basket
// buys/sells reuse this route.
const BOOK_ID = "CLIENT-BUY";
const BROKER = process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE";
const ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE?.trim() || "56378";

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.MINT_CLIENT_ORDER_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret && bearer === secret) return true;
  const auth = await getAdminContext();
  return auth.status === "ok";
}

export async function POST(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (process.env.IRESS_UAT_MODE !== "true") {
    return NextResponse.json({ ok: false, error: "IRESS_UAT_MODE is not enabled." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const holdingId = typeof body.holding_id === "string" ? body.holding_id.trim() : "";
  const rawSymbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Math.floor(Number(body.qty));
  const priceCentsRaw = body.price_cents == null ? null : Number(body.price_cents);
  const priceCents = priceCentsRaw != null && Number.isFinite(priceCentsRaw) && priceCentsRaw > 0 ? Math.round(priceCentsRaw) : null;
  const clientEmail = typeof body.client_email === "string" ? body.client_email : "mint-client@system";

  if (!holdingId) return NextResponse.json({ ok: false, error: "holding_id is required" }, { status: 400 });
  if (!rawSymbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ ok: false, error: "qty must be a positive integer" }, { status: 400 });
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

  // ── Idempotency: a retried mint request for the same holding is a no-op. ──
  const v = holdingId.replace(/[\\"]/g, "");
  const { data: existing, error: existingErr } = await supabase.institutional
    .from("oems_order_audit")
    .select("id, order_id, status")
    .eq("payload->>holding_id", v)
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    return NextResponse.json({ ok: false, error: `Idempotency check failed: ${existingErr.message}` }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({
      ok: true,
      alreadyForwarded: true,
      orderAuditId: existing.id,
      orderId: existing.order_id,
      bookId: BOOK_ID,
      mode: "uat",
      status: existing.status,
    });
  }

  // ── CLIENT-DATA GUARD: refuse fail-closed unless the holding's owner is a ──
  // ── test/UAT account. Real clients must never reach IRESS through this. ──
  const { data: holding, error: holdingErr } = await supabase.retail
    .from("stock_holdings_c")
    .select("id, user_id")
    .eq("id", holdingId)
    .maybeSingle();
  if (holdingErr || !holding) {
    return NextResponse.json(
      { ok: false, error: `Could not resolve holding '${holdingId}': ${holdingErr?.message ?? "not found"}` },
      { status: 404 },
    );
  }
  const [{ data: testProfile }, { data: testWallet }] = await Promise.all([
    supabase.retail.from("profiles").select("id").eq("id", holding.user_id).eq("is_test", true).maybeSingle(),
    supabase.retail.from("wallets").select("user_id").eq("user_id", holding.user_id).eq("status", "test").maybeSingle(),
  ]);
  if (!testProfile && !testWallet) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Refused: this holding belongs to a real (non-test) client. MINT_CLIENT_ORDER forwarding is UAT-only for now — only is_test=true / wallet status='test' accounts may forward to IRESS.",
      },
      { status: 422 },
    );
  }

  // Preflight explicitly first so a blocked verdict returns the same shape
  // the ad-hoc ticket does (no audit row written; UI can render force-
  // correction if mint ever surfaces this directly).
  const pre = await preflight({
    account_code: ACCOUNT_CODE,
    symbol: rawSymbol,
    side,
    qty,
    price_cents: priceCents,
    source: "MINT_CLIENT_ORDER",
    book_id: BOOK_ID,
  });
  if (!pre.ok) {
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

  const result: SubmitResult = await submitOrder(
    supabase,
    {
      account_code: ACCOUNT_CODE,
      symbol: rawSymbol,
      side,
      qty,
      price_cents: priceCents,
      source: "MINT_CLIENT_ORDER",
      book_id: BOOK_ID,
      trader_email: clientEmail,
      holding_id: holdingId,
    },
    { bookId: BOOK_ID, broker: BROKER, uatTest: true },
  );

  if (!result.ok && !result.order_audit_id) {
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
