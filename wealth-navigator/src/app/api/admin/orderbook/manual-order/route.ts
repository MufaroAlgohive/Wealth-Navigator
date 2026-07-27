import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isUatEnv } from "@/lib/oems/uat-scope";
import { openSupabaseClients, parkOrder, preflight } from "@/lib/orders";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/manual-order
 *
 * Manual client order, placed by the desk on a named client's behalf.
 * Replaces the UAT-only ad-hoc ticket (`/uat-order`), which could only trade
 * the desk book and was gated on IRESS_UAT_MODE.
 *
 * TWO-PHASE, deliberately (Juan, 2026-07-27):
 *   1. THIS route PARKS the order. Zero worker contact, zero IRESS contact,
 *      zero broker contact. It appears on the order book immediately.
 *   2. Nothing reaches LONGMARK until someone clicks Send to Market, which
 *      goes through `release-to-market` and runs a FRESH preflight at that
 *      moment — not the stale one from park time.
 *
 * A parked order can be killed before that click via `cancel-parked`.
 *
 * WHAT THE BROKER SEES. Not the client. LONGMARK holds no client accounts —
 * only the MINT account — so the order that leaves here is an instruction from
 * MINT to buy or sell a quantity of a security. The client attribution lives in
 * OUR audit row (`payload.user_id`) and is what lets us do the breakdown
 * internally and, critically, enforce that client's own limits.
 *
 * WHY user_id MATTERS. It is what makes `resolveHolderKind` classify this as a
 * CLIENT order, which routes the worker's pre-trade guard to that client's own
 * wallet and holdings (`availableToBuyForClient` / `availableToSellForClient`)
 * instead of the desk omnibus. That is the "if the client has R1000 available,
 * he can only execute within that" rule. Without user_id the order silently
 * checks the desk's cash and the rule does not exist.
 *
 * Body: {
 *   user_id:      string,            // REQUIRED — the client this order is for
 *   symbol:       string,
 *   side:         "buy" | "sell",
 *   qty:          number,
 *   price?:       number | null,     // RANDS. omit/0 = market order
 *   book_id?:     string
 * }
 */

export const dynamic = "force-dynamic";

const DEFAULT_BOOK_ID = "MANUAL";

const BROKER = (() => {
  if (isUatEnv()) return process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE";
  return (
    process.env.IRESS_PRODUCTION_DESTINATION?.trim() ||
    process.env.IRESS_DESTINATION?.trim() ||
    "LONGMARK CARE"
  );
})();
const ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE?.trim() || "";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const traderEmail = auth.ctx.email ?? "desk@mint";

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Math.floor(Number(body.qty));
  const priceRaw = body.price == null || body.price === "" ? null : Number(body.price);
  const priceCents =
    priceRaw != null && Number.isFinite(priceRaw) && priceRaw > 0 ? Math.round(priceRaw * 100) : null;
  const bookId =
    typeof body.book_id === "string" && body.book_id.trim() ? body.book_id.trim() : DEFAULT_BOOK_ID;

  // user_id is required, not optional-with-a-desk-fallback. Defaulting it would
  // silently place a client's trade against the desk's cash and holdings.
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "user_id is required — select the client this order is for" },
      { status: 400 },
    );
  }
  if (!symbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ ok: false, error: "qty must be a positive integer" }, { status: 400 });
  }

  // Confirm the client exists before writing an audit row against them. A typo
  // in a user_id would otherwise produce a parked order attributed to nobody,
  // which then fails closed at release time with a confusing 422.
  let clientLabel = userId.slice(0, 8);
  // Rendered as the order book's "Client" column. Two Juan profiles exist with
  // different wallets, so an email is the only unambiguous label.
  let clientEmail: string | null = null;
  try {
    const retail = createRetailServiceRoleClient();
    const { data: prof } = await retail
      .from("profiles")
      .select("id, first_name, last_name, email")
      .eq("id", userId)
      .maybeSingle();
    if (!prof) {
      return NextResponse.json(
        { ok: false, error: `No MINT client with id ${userId}` },
        { status: 404 },
      );
    }
    const p = prof as { first_name: string | null; last_name: string | null; email: string | null };
    clientEmail = p.email;
    clientLabel = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email || clientLabel;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `retail database unavailable: ${(e as Error).message}` },
      { status: 503 },
    );
  }

  const supabase = await openSupabaseClients();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }

  /* Advisory preflight. The BINDING check runs again at release time against
     live balances — this one exists so the dealer is told "that exceeds the
     client's available cash" while still on the ticket, instead of parking an
     order that can never be released. A failure to reach the worker is NOT
     fatal here: parking touches no broker, so we park anyway and let the
     release-time guard be the gate. */
  let advisory: Awaited<ReturnType<typeof preflight>> | null = null;
  try {
    advisory = await preflight({
      account_code: ACCOUNT_CODE || BROKER,
      symbol,
      side,
      qty,
      price_cents: priceCents,
      source: "MANUAL_CLIENT_ORDER",
      book_id: bookId,
      user_id: userId,
    });
  } catch {
    advisory = null;
  }

  const parked = await parkOrder(
    supabase,
    {
      account_code: ACCOUNT_CODE || BROKER,
      symbol,
      side,
      qty,
      price_cents: priceCents,
      trader_email: traderEmail,
      // The order book's "Client" column. Without this it shows the DEALER who
      // clicked the button, not the client whose money is at risk — verified
      // 2026-07-27: an order placed for juan.vanwyk@mymint displayed as
      // juan@autonama (the logged-in admin), which is exactly the confusion a
      // dealer must not have when deciding what to release.
      client_account: clientEmail ?? clientLabel,
      // No stock_holdings_c row backs a manual ticket — the order is being
      // originated here rather than mirrored from one the client already placed.
      holding_id: null,
      // The whole point: routes the release-time guard to THIS client's ledger.
      user_id: userId,
      source: "MANUAL_CLIENT_ORDER",
    },
    { bookId, broker: BROKER, uatTest: isUatEnv() },
  );

  if (!parked.ok) {
    return NextResponse.json({ ok: false, error: parked.error ?? "park failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: "parked",
    order_audit_id: parked.order_audit_id,
    order_id: parked.order_id,
    book_id: bookId,
    client: { user_id: userId, name: clientLabel },
    symbol,
    side,
    qty,
    price_rands: priceCents != null ? priceCents / 100 : null,
    order_type: priceCents != null ? "limit (reference)" : "market",
    broker_destination: BROKER,
    advisory_preflight: advisory,
    notice:
      "Parked. Nothing has reached IRESS or LONGMARK. Use Send to Market to release, which re-runs the client's cash and holdings checks against live balances at that moment.",
  });
}
