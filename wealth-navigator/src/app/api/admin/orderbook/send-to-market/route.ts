import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/send-to-market
 *
 * Mint OEM Phase B3 — dispatches a book of orders to the broker by writing
 * one execution row per ISIN into `oems_order_audit` (status='working') and,
 * when the table is migrated, raising a paired `rebalance_request_c` row
 * (status='ic_approved') so the desk has a paper trail for downstream
 * confirmation.
 *
 * Body: { book_id: string, broker: string, order_type: "limit" | "market" }
 * Returns: { ok, execution_ids, rebalance_id?, notice? }
 *
 * Business rule (Lonwabo): limit must be > 0. If the book contains ISINs
 * without a recorded `expectedFill` and the order_type is "limit", we reject
 * with 400 — the dealer must capture limits first.
 *
 * Degradation: `rebalance_request_c` may not be migrated yet (Phase A5).
 * The handler treats a 42P01 as a soft failure and still writes the
 * `oems_order_audit` rows so the desk can dispatch. The response carries
 * `rebalance_id: null` and a `notice` describing the fallback.
 */

export const dynamic = "force-dynamic";

interface Holding {
  id: string;
  user_id: string;
  security_id: string;
  quantity: number;
  avg_fill: number | null;
  Expected_fill: number | null;
  trade_side: string;
  strategy_name_snapshot: string | null;
}

interface Security {
  id: string;
  symbol: string;
  name: string | null;
  isin: string | null;
  last_price: number | null;
}

interface Profile {
  id: string;
  email: string | null;
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
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

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bookId = typeof body.book_id === "string" ? body.book_id.trim() : "";
  const broker = typeof body.broker === "string" ? body.broker.trim() : "";
  const orderType = body.order_type === "market" ? "market" : "limit";

  if (!bookId) return NextResponse.json({ ok: false, error: "book_id is required" }, { status: 400 });
  if (!broker) return NextResponse.json({ ok: false, error: "broker is required" }, { status: 400 });
  if (orderType !== "limit" && orderType !== "market") {
    return NextResponse.json({ ok: false, error: "order_type must be 'limit' or 'market'" }, { status: 400 });
  }

  // The "book" is logically a per-user set of holdings tied to a strategy.
  // book_id is the strategy_name_snapshot (the grouping key) today — once
  // a dedicated `order_book_c` table exists we'll switch. Resolve the rows
  // from the RETAIL `stock_holdings_c` audit mirror.
  const retail = await (async (): Promise<SupabaseClient | null> => {
    try {
      const { createRetailServiceRoleClient } = await import("@/lib/supabase/server");
      return createRetailServiceRoleClient();
    } catch {
      return null;
    }
  })();

  if (!retail) {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const { data: holds, error: holdsErr } = await retail
    .from("stock_holdings_c")
    .select("id, user_id, security_id, quantity, avg_fill, Expected_fill, trade_side, strategy_name_snapshot")
    .eq("strategy_name_snapshot", bookId)
    .eq("is_active", true);

  if (holdsErr) {
    return NextResponse.json({ ok: false, error: holdsErr.message }, { status: 500 });
  }

  const holdings = (holds ?? []) as Holding[];
  if (holdings.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No active holdings found for that book_id." },
      { status: 404 },
    );
  }

  // Validate limits if order_type=limit (must be > 0 cents).
  if (orderType === "limit") {
    const missing = holdings.filter(
      (h) => !Number.isFinite(Number(h.Expected_fill)) || Number(h.Expected_fill) <= 0,
    );
    if (missing.length) {
      return NextResponse.json(
        {
          ok: false,
          error: `Limit price must be > 0. ${missing.length} holding(s) have no recorded expected fill.`,
          missing_ids: missing.map((h) => h.id),
        },
        { status: 400 },
      );
    }
  }

  // Resolve securities + accounts for the execution rows.
  const secIds = [...new Set(holdings.map((h) => h.security_id).filter(Boolean))];
  const userIds = [...new Set(holdings.map((h) => h.user_id).filter(Boolean))];

  const [{ data: secs }, { data: profs }] = await Promise.all([
    retail.from("securities_c").select("id, symbol, name, isin, last_price").in("id", secIds),
    retail.from("profiles").select("id, email").in("id", userIds),
  ]);

  const secMap: Record<string, Security> = {};
  for (const s of (secs ?? []) as Security[]) secMap[s.id] = s;
  const profMap: Record<string, Profile> = {};
  for (const p of (profs ?? []) as Profile[]) profMap[p.id] = p;

  const institutional = openInstitutional();
  if (!institutional) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  // Build execution rows (one per ISIN per holding). order_id is the strategy
  // book so the desk can group/aggregate on the front-end.
  const executionRows = holdings.map((h, idx) => {
    const sec = secMap[h.security_id];
    const prof = profMap[h.user_id];
    const limitRands = orderType === "limit" ? Number(h.Expected_fill ?? 0) / 100 : 0;
    const orderId = `OB-${bookId}-${Date.now().toString(36)}-${idx}`;
    return {
      order_id: orderId,
      client_account: prof?.email ?? h.user_id,
      symbol: sec?.symbol ?? "—",
      side: (h.trade_side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
      quantity: Number(h.quantity) || 0,
      price_cents: orderType === "limit" ? Math.round(limitRands * 100) : null,
      status: "working",
      source: `OB_SEND_TO_MARKET:${broker}`,
      payload: {
        book_id: bookId,
        broker,
        order_type: orderType,
        strategy: bookId,
        security_id: h.security_id,
        isin: sec?.isin ?? null,
        limitPrice: orderType === "limit" ? limitRands : null,
        sent_by: auth.ctx.email,
        sent_at: new Date().toISOString(),
        holding_id: h.id,
        trader: auth.ctx.email,
      },
      result_payload: {
        broker,
        venue: "JSE",
        tif: "DAY",
        arrivalMid: sec?.last_price != null ? Number(sec.last_price) / 100 : null,
      },
    };
  });

  const { data: inserted, error: insertErr } = await institutional
    .from("oems_order_audit")
    .insert(executionRows)
    .select("id, order_id");

  if (insertErr) {
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  // Optional rebalance_request_c mirror. Degrade softly if the table is missing.
  let rebalanceId: string | null = null;
  let rebalanceNotice: string | null = null;
  try {
    const proposedComposition = holdings.map((h) => {
      const sec = secMap[h.security_id];
      return {
        symbol: sec?.symbol ?? null,
        isin: sec?.isin ?? null,
        side: (h.trade_side ?? "buy").toLowerCase(),
        qty: Number(h.quantity) || 0,
        limit_cents: orderType === "limit" ? Math.round(Number(h.Expected_fill ?? 0)) : null,
      };
    });
    const { data: rbRow, error: rbErr } = await institutional
      .from("rebalance_request_c")
      .insert({
        strategy_id: bookId,
        requested_by: auth.ctx.email,
        current_composition: [],
        proposed_composition: proposedComposition,
        affected_investors: userIds,
        status: "ic_approved",
      })
      .select("id")
      .maybeSingle();

    if (rbErr) {
      if (isSupabaseSchemaMissing(rbErr)) {
        rebalanceNotice =
          "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql. Execution rows written to oems_order_audit only.";
      } else {
        rebalanceNotice = `rebalance_request_c insert failed: ${rbErr.message}`;
      }
    } else {
      rebalanceId = (rbRow?.id as string) ?? null;
    }
  } catch (e) {
    rebalanceNotice = `rebalance_request_c insert failed: ${(e as Error).message}`;
  }

  return NextResponse.json({
    ok: true,
    execution_ids: (inserted ?? []).map((r) => r.id),
    order_ids: (inserted ?? []).map((r) => r.order_id),
    rebalance_id: rebalanceId,
    notice: rebalanceNotice,
    count: executionRows.length,
  });
}
