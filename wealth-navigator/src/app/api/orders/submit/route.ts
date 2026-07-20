/**
 * POST /api/orders/submit
 *
 * Auth-gated order submission. Thin wrapper around `submitOrder()` from
 * the core `src/lib/orders/` module — the same helper the UAT ad-hoc and
 * bulk send-to-market routes use internally.
 *
 * Body: {
 *   account_code:  string,
 *   symbol:        string,
 *   side:          "buy" | "sell",
 *   qty:           number,
 *   price_cents?:  number | null,
 *   source:        OrderSource,    // "BLOTTER_NEW_ORDER" | "RESEARCH_LAB_THESIS" | ...
 *   book_id?:      string,
 *   broker?:       string,         // IRESS destination override (defaults to LONGMARK CARE)
 *   uat_test?:     boolean,
 * }
 *
 * Returns the `SubmitResult` shape verbatim:
 *   - `ok: false, preflight: <blocked>` → 422, no audit row written. The UI
 *     opens `<GuardrailForceCorrectionDialog/>`.
 *   - `ok: true, order_audit_id, iress_order_number` → 200, audit row written.
 *   - `ok: false, order_audit_id, error` → 200 with `worker_code`, audit row
 *     stamped `rejected`. The UI surfaces the worker's reason inline.
 *
 * Used by:
 *   - `/oems/blotter` `NewOrderDialog` (real-data mode; replaces the
 *     client-side `orderCreate3WithRecovery` direct-to-broker path).
 *   - Future: research-lab → submit thesis, paper-model rebalance button.
 *
 * See plan §2 (BFF routes → thin auth wrappers) and §3 (shared modal).
 */

import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { openSupabaseClients, submitOrder } from "@/lib/orders";
import type { OrderSide, OrderSource, SubmitResult } from "@/lib/orders";

export const dynamic = "force-dynamic";

const VALID_SOURCES: OrderSource[] = [
  "BLOTTER_NEW_ORDER",
  "RESEARCH_LAB_THESIS",
  "PAPER_MODEL_REBALANCE",
  "UAT_ADHOC_ORDER",
  "OB_SEND_TO_MARKET_UAT",
];
const VALID_SIDES: OrderSide[] = ["buy", "sell"];

export async function POST(req: Request) {
  // Auth gate — trader_email is stamped onto the audit row. We only need
  // the signed-in email here (no admin RBAC, since the blotter is the
  // live desk surface and any authenticated user can submit). If the
  // cookie-backed client can't even be created, the env is misconfigured.
  let traderEmail = "";
  try {
    const auth = await createSupabaseServerClient();
    const { data } = await auth.auth.getUser();
    traderEmail = data?.user?.email ?? "";
  } catch {
    return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  }
  if (!traderEmail) {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Number(body.qty);
  const priceCentsRaw = body.price_cents;
  const priceCents =
    priceCentsRaw != null && Number.isFinite(Number(priceCentsRaw)) && Number(priceCentsRaw) > 0
      ? Math.round(Number(priceCentsRaw))
      : null;
  const source = String(body.source ?? "BLOTTER_NEW_ORDER") as OrderSource;
  const bookId = typeof body.book_id === "string" ? body.book_id : undefined;
  const broker =
    typeof body.broker === "string" && body.broker.trim().length > 0 ? body.broker.trim() : undefined;
  const uatTest = body.uat_test === true;

  if (!symbol) {
    return NextResponse.json({ ok: false, error: "`symbol` is required" }, { status: 400 });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ ok: false, error: "`qty` must be a positive number" }, { status: 400 });
  }
  if (!VALID_SIDES.includes(side)) {
    return NextResponse.json({ ok: false, error: "`side` must be 'buy' or 'sell'" }, { status: 400 });
  }
  if (!VALID_SOURCES.includes(source)) {
    return NextResponse.json(
      {
        ok: false,
        error: `\`source\` must be one of ${VALID_SOURCES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const accountCode =
    typeof body.account_code === "string" && body.account_code.trim().length > 0
      ? body.account_code.trim()
      : process.env.IRESS_ACCOUNT_CODE?.trim() || "56378";

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
      account_code: accountCode,
      symbol,
      side,
      qty: Math.floor(qty),
      price_cents: priceCents,
      source,
      book_id: bookId,
      trader_email: traderEmail,
    },
    { broker, uatTest, bookId },
  );

  // Pass → 200; blocked preflight → 422 (no row); worker-rejected post-insert → 200 with `ok: false`.
  if (!result.ok && !result.order_audit_id) {
    return NextResponse.json(result, { status: 422 });
  }
  return NextResponse.json(result, { status: 200 });
}
