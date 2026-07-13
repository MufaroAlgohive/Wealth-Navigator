import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/test-seed-holding
 *
 * Mint OEM Finalisation Phase UAT — inserts a single row into RETAIL
 * `stock_holdings_c` for a UAT test scenario. The send-to-market BFF
 * resolves a strategy by `strategy_name_snapshot` (the "book id"), so
 * the test runner needs at least one row per (book_id, symbol) to
 * dispatch an order.
 *
 * The endpoint is gated behind:
 *   - Admin context (the existing orderbook permission set)
 *   - `IRESS_UAT_MODE === "true"` on Vercel (refuses 403 otherwise)
 *
 * Test rows are tagged `strategy_name_snapshot LIKE 'UAT-%'`, so a single
 * SQL one-liner cleans them up after the run:
 *
 *   DELETE FROM stock_holdings_c WHERE strategy_name_snapshot LIKE 'UAT-%';
 *
 * Body: { book_id, symbol, qty, limit_cents, side }
 * Returns: { ok, holding_id, security_id, user_id }
 */

export const dynamic = "force-dynamic";

interface Body {
  book_id: string;
  symbol: string;
  qty: number;
  limit_cents: number;
  side: "buy" | "sell";
}

interface Security {
  id: string;
  symbol: string;
}

interface Profile {
  id: string;
  email: string | null;
}

function openRetail(): SupabaseClient | null {
  try {
    return createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  if (process.env.IRESS_UAT_MODE !== "true") {
    return NextResponse.json(
      { ok: false, error: "UAT mode is not enabled on Vercel (IRESS_UAT_MODE!=true)" },
      { status: 403 },
    );
  }

  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Partial<Body>;
  const bookId = typeof body.book_id === "string" ? body.book_id.trim() : "";
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const qty = Number(body.qty) || 0;
  const limitCents = Number(body.limit_cents) || 0;
  const side: "buy" | "sell" = body.side === "sell" ? "sell" : "buy";

  if (!bookId) return NextResponse.json({ ok: false, error: "book_id is required" }, { status: 400 });
  if (!symbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  if (qty <= 0) return NextResponse.json({ ok: false, error: "qty must be > 0" }, { status: 400 });
  if (limitCents <= 0)
    return NextResponse.json({ ok: false, error: "limit_cents must be > 0" }, { status: 400 });
  if (!bookId.startsWith("UAT-")) {
    return NextResponse.json(
      { ok: false, error: "book_id must start with 'UAT-' (UAT only — no production seed)" },
      { status: 400 },
    );
  }

  const retail = openRetail();
  if (!retail) {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  // Resolve security_id from symbol. RETAIL securities_c stores JSE symbols in
  // the ".JO" form (e.g. "SOL.JO"), but the scenarios pass the bare code
  // ("SOL"), so try both forms. This is what previously 404'd the seed.
  const symbolCandidates = symbol.includes(".") ? [symbol] : [symbol, `${symbol}.JO`];
  const { data: secRows, error: secErr } = await retail
    .from("securities_c")
    .select("id, symbol")
    .in("symbol", symbolCandidates)
    .limit(1);

  if (secErr) {
    if (isSupabaseSchemaMissing(secErr)) {
      return NextResponse.json({ ok: false, error: "securities_c table not migrated yet" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: secErr.message }, { status: 500 });
  }
  const sec = Array.isArray(secRows) ? (secRows[0] as Security | undefined) : undefined;
  if (!sec) {
    return NextResponse.json(
      { ok: false, error: `symbol ${symbol} not found in securities_c (tried ${symbolCandidates.join(", ")})` },
      { status: 404 },
    );
  }
  const securityId = sec.id;

  // Resolve a TEST user to own the holding. It MUST be an is_test=true profile.
  // A UAT test holding attached to a real (non-test) client pollutes the LIVE
  // Active order book (that scope shows non-test-profile holdings). So we ONLY
  // ever seed onto a test profile and refuse otherwise — never fall back to a
  // real client. Prefer the signed-in admin's profile only if it is itself a
  // test profile.
  const { data: adminProf } = await retail
    .from("profiles")
    .select("id, email, is_test")
    .ilike("email", auth.ctx.email)
    .eq("is_test", true)
    .limit(1)
    .maybeSingle();

  let profile = (adminProf as Profile | null) ?? null;
  if (!profile?.id) {
    const { data: testProf, error: testErr } = await retail
      .from("profiles")
      .select("id, email, is_test")
      .eq("is_test", true)
      .limit(1)
      .maybeSingle();
    if (testErr) {
      return NextResponse.json({ ok: false, error: testErr.message }, { status: 500 });
    }
    profile = (testProf as Profile | null) ?? null;
  }
  if (!profile?.id) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No RETAIL test profile (is_test=true) exists. Create a test profile before seeding UAT holdings — test data must never attach to a real client.",
      },
      { status: 422 },
    );
  }
  const userId = profile.id;

  const { data: inserted, error: insertErr } = await retail
    .from("stock_holdings_c")
    .insert({
      user_id: userId,
      security_id: securityId,
      quantity: qty,
      avg_fill: 0,
      Expected_fill: limitCents,
      // stock_holdings_c has a CHECK constraint requiring UPPERCASE trade_side
      // ("BUY"/"SELL"); a lowercase value fails with 23514 (surfaced as 500).
      trade_side: side.toUpperCase(),
      strategy_name_snapshot: bookId,
      is_active: true,
      Fill_date: null,
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    if (isSupabaseSchemaMissing(insertErr)) {
      return NextResponse.json(
        { ok: false, error: "stock_holdings_c table not migrated yet" },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    holding_id: (inserted?.id as string) ?? null,
    security_id: securityId,
    user_id: userId,
    book_id: bookId,
    symbol,
    qty,
    limit_cents: limitCents,
    side,
  });
}
