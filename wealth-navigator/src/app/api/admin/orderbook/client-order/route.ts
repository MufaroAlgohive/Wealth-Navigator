/**
 * POST /api/admin/orderbook/client-order
 *
 * Server-to-server entry point for the MINT retail app: when a client buys
 * (Phase 1) or sells (later) a single security, mint calls this route so
 * the SAME order — same ticker, qty, price — that already gets written to
 * `stock_holdings_c` also lands in the OEM order book. This route PARKS the
 * order (`parkOrder()` from `@/lib/orders`) — zero worker/IRESS contact —
 * until an admin releases it via `POST /api/admin/orderbook/release-to-market`,
 * which runs preflight + the worker fan-out this route used to run inline.
 *
 * Body: {
 *   holding_id:    string,           // stock_holdings_c.id this order came from
 *   symbol:        string,
 *   side:          "buy" | "sell",
 *   qty:           number,
 *   price_cents?:  number | null,    // omit/null = market order
 *   client_email?: string,
 *   source_ref?:   string,           // mint's transaction id, for cross-system log tracing
 *   book_id?:      string,           // strategy display name for a basket buy (one call per
 *                                    // constituent holding); omitted = single-security buy,
 *                                    // falls back to the fixed "CLIENT-BUY" grouping label
 * }
 * Returns: { ok, orderAuditId, orderId, bookId, mode, status, notice?, error?, alreadyForwarded? }
 *
 * Auth: `Authorization: Bearer ${MINT_CLIENT_ORDER_SECRET}` (mint has no
 * admin browser session to present), OR an admin session as a fallback for
 * manual testing from the admin UI.
 *
 * Production-aware (2026-07-23): the previous `IRESS_UAT_MODE=true` gate
 * has been removed — the route now follows the same env-driven
 * UAT-vs-prod detection as the rest of the app (`isUatEnv()`). The actual
 * IRESS seat the order reaches is decided by the worker's
 * `IRESS_BASE_URL` + `IRESS_IOS_SERVER`; this route only tags the audit
 * row's `uatTest` flag accordingly (true on UAT, false on production).
 *
 * 2026-07-23: the CLIENT-DATA GUARD (test-account/allowlist-only check)
 * that used to sit here has been removed — it was silently refusing real
 * clients' orders before they ever reached the order book, even though
 * this route has zero broker contact either way (see PARKS above). The
 * real safety boundary is release-to-market/route.ts's RBAC-gated "Send
 * to Market" click; a wrong or unwanted parked order can still be killed
 * before that click via cancel-parked/route.ts. Every mint client order —
 * real or test — now parks and shows on the order book immediately.
 *
 * Idempotency: keyed on `payload->>holding_id` — a retried mint request for
 * the same holding is a no-op success (`alreadyForwarded: true`), not a
 * second order.
 */

import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { openSupabaseClients, parkOrder } from "@/lib/orders";
import { isUatEnv } from "@/lib/oems/uat-scope";

export const dynamic = "force-dynamic";

// Fallback grouping label for single-security client orders — a UI label
// only (see `groupRowsByStrategy()`), not the real join key. The real join
// between a specific investor's specific position and its IRESS status is
// `payload.holding_id`. A basket buy overrides this via the optional
// `book_id` request field (the strategy's display name), one call per
// constituent holding — see wealthNavigatorClient.js on mint's side.
const BOOK_ID = "CLIENT-BUY";
// Broker destination label for the audit payload. Production uses the
// production destination (env `IRESS_DESTINATION`); the UAT lane keeps
// `IRESS_UAT_DESTINATION` (default `LONGMARK CARE`). The label is cosmetic —
// the actual IRESS seat the order reaches is decided by the worker's
// `IRESS_BASE_URL` + `IRESS_IOS_SERVER`, not by this string.
const BROKER = (() => {
  if (isUatEnv()) {
    return process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE";
  }
  return process.env.IRESS_DESTINATION?.trim() || "LONGMARK CARE";
})();
const ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE?.trim() || "";

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
  // No `IRESS_UAT_MODE` gate: the route follows the same env-driven
  // UAT-vs-prod detection as the rest of the app (`isUatEnv()` — see
  // lib/oems/uat-scope.ts). The lane the order lands on is decided by the
  // worker's `IRESS_BASE_URL` + `IRESS_IOS_SERVER`; this route just tags
  // the audit row accordingly via `uatTest` (see parkOrder below).

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const holdingId = typeof body.holding_id === "string" ? body.holding_id.trim() : "";
  const rawSymbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Math.floor(Number(body.qty));
  const priceCentsRaw = body.price_cents == null ? null : Number(body.price_cents);
  const priceCents = priceCentsRaw != null && Number.isFinite(priceCentsRaw) && priceCentsRaw > 0 ? Math.round(priceCentsRaw) : null;
  const clientEmail = typeof body.client_email === "string" ? body.client_email : "mint-client@system";
  const bodyBookId = typeof body.book_id === "string" && body.book_id.trim() ? body.book_id.trim() : BOOK_ID;

  if (!holdingId) return NextResponse.json({ ok: false, error: "holding_id is required" }, { status: 400 });
  if (!rawSymbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ ok: false, error: "qty must be a positive integer" }, { status: 400 });
  }
  if (!ACCOUNT_CODE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "IRESS_ACCOUNT_CODE is not set. Production must set IRESS_ACCOUNT_CODE explicitly (no UAT fallback); set it in Vercel + Railway env.",
      },
      { status: 503 },
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
      bookId: bodyBookId,
      mode: isUatEnv() ? "uat" : "production",
      status: existing.status,
    });
  }

  // Confirm the holding actually exists — a data-integrity check, not a
  // gate on who may order. Every client's order (real or test) parks here;
  // the broker-facing gate lives at release time (see route doc comment).
  //
  // 2026-07-27: this used to select only "id". The holding carries the
  // client's user_id, and it is required downstream: the per-client pre-trade
  // guard routes on payload.user_id, and fill settlement refuses to move money
  // for an order it cannot attribute to a client. Every desk-placed MANUAL_CLIENT_ORDER carried user_id; every
  // app-placed MINT_CLIENT_ORDER did not, so an app order would have filled
  // at the broker and then been silently skipped by settlement — the client
  // debited nothing and owning nothing, which is the exact failure this whole
  // path exists to prevent. We were discarding a column already in hand.
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
  const holdingRow = holding as { id: string; user_id: string | null };
  if (!holdingRow.user_id) {
    // Fail loudly rather than park an unattributable order. A parked order we
    // cannot settle is worse than one we refuse to place: it reaches the market
    // and then strands the client.
    return NextResponse.json(
      {
        ok: false,
        error: `Holding '${holdingId}' has no user_id — refusing to place an order that could not be settled to a client.`,
      },
      { status: 422 },
    );
  }

  // No preflight here — this order PARKS with zero worker/IRESS contact.
  // Preflight is deferred to release time (see submit.ts::parkOrder /
  // releaseOrder), when the cash/naked-short snapshot is actually current.
  // `uatTest` is derived from the deployment lane (`isUatEnv()`) so the
  // audit row accurately tags production orders vs UAT test orders.
  const uatTest = isUatEnv();
  const result = await parkOrder(
    supabase,
    {
      account_code: ACCOUNT_CODE,
      symbol: rawSymbol,
      side,
      qty,
      price_cents: priceCents,
      source: "MINT_CLIENT_ORDER",
      book_id: bodyBookId,
      trader_email: clientEmail,
      holding_id: holdingId,
      // Attribution. Without this the fill cannot be settled to a client.
      // security_id is NOT passed — parkOrder derives it from the symbol
      // lookup, which is the canonical resolution path.
      user_id: holdingRow.user_id,
    },
    { bookId: bodyBookId, broker: BROKER, uatTest },
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, bookId: bodyBookId, error: result.error ?? "failed to park order" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    orderAuditId: result.order_audit_id,
    orderId: result.order_id,
    bookId: bodyBookId,
    mode: uatTest ? "uat" : "production",
    status: "parked",
    notice: uatTest
      ? "UAT order parked in the order book — awaiting Send to Market release."
      : "Production order parked in the order book — awaiting Send to Market release.",
  });
}
