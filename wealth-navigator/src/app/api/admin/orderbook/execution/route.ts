import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/orderbook/execution?book_id=...
 *
 * Mint OEM Phase B3 — per-ISIN execution view. Reads `oems_order_audit` rows
 * tied to a book (the `payload.book_id` or `payload.strategy` column) and
 * normalises them into the columns the execution view expects:
 *
 *   order_id, ts, strategy, side, symbol, qty, filled, qty_pct,
 *   limit_price, avg_fill_price, slippage_cents, venue, tif, sent_by, state.
 *
 * Returns: { ok, rows, notice? }
 *
 * Schema-missing guard: returns `{ ok: true, rows: [], notice: ... }` so the
 * UI can render an honest empty state without an alert banner when the table
 * hasn't been migrated yet.
 */

export const dynamic = "force-dynamic";

interface AuditRow {
  id: string;
  order_id: string;
  client_account: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  source: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  id: string;
  order_id: string;
  ts: string;
  strategy: string | null;
  side: string;
  symbol: string;
  isin: string | null;
  qty: number;
  filled: number;
  filled_pct: number;
  limit_price: number | null;
  avg_fill_price: number | null;
  vwap: number | null;
  slippage_cents: number | null;
  day1_pnl_cents: number | null;
  venue: string;
  tif: string;
  sent_by: string | null;
  state: string;
  broker: string | null;
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: AuditRow): ExecutionRow {
  const payload = r.payload ?? {};
  const result = r.result_payload ?? {};
  const limitPrice = num(payload.limitPrice) ?? (r.price_cents != null ? Number(r.price_cents) / 100 : null);

  // Filled quantity: prefer payload.filled (the canonical execution field);
  // fall back to payload.avgPx presence or compute from result.
  const filled = num(payload.filled) ?? (typeof payload.avgPx === "number" ? Number(r.quantity) : 0);
  const qty = Number(r.quantity) || 0;
  const filledPct = qty > 0 ? Math.min(100, (filled / qty) * 100) : 0;

  const avgFill = num(payload.avgPx) ?? num(result.avgFillPrice) ?? num(result.avg_fill_price);

  // Slip = limit − actual fill (in cents). GREEN when fill < client limit.
  let slippageCents: number | null = null;
  if (limitPrice != null && avgFill != null) {
    slippageCents = Math.round((limitPrice - avgFill) * 100);
  }

  // Day-1 P&L proxy = slippage * qty (in cents)
  let day1PnlCents: number | null = null;
  if (slippageCents != null) day1PnlCents = slippageCents * filled;

  const state = ((): ExecutionRow["state"] => {
    switch (r.status) {
      case "filled":
        return "FILLED";
      case "partial":
        return "PARTIAL";
      case "cancelled":
        return "CANCELLED";
      case "rejected":
        return "REJECTED";
      default:
        return "WORKING";
    }
  })();

  return {
    id: r.id,
    order_id: r.order_id,
    ts: typeof payload.ts === "string" ? (payload.ts as string) : r.updated_at,
    strategy: typeof payload.strategy === "string" ? (payload.strategy as string) : null,
    side: (r.side ?? "buy").toUpperCase(),
    symbol: r.symbol,
    isin: typeof payload.isin === "string" ? (payload.isin as string) : null,
    qty,
    filled,
    filled_pct: Number(filledPct.toFixed(1)),
    limit_price: limitPrice,
    avg_fill_price: avgFill,
    vwap: num(payload.vwap),
    slippage_cents: slippageCents,
    day1_pnl_cents: day1PnlCents,
    venue: typeof payload.destination === "string" ? (payload.destination as string) : "JSE",
    tif: typeof payload.tif === "string" ? (payload.tif as string) : "DAY",
    sent_by:
      typeof payload.sent_by === "string"
        ? (payload.sent_by as string)
        : typeof payload.trader === "string"
          ? (payload.trader as string)
          : null,
    state,
    broker: typeof payload.broker === "string" ? (payload.broker as string) : null,
  };
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const bookId = (url.searchParams.get("book_id") ?? "").trim();

  const db = openInstitutional();
  if (!db) {
    return NextResponse.json({
      ok: true,
      rows: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  // Audit doesn't have a dedicated book_id column; we filter by either
  // payload.book_id OR payload.strategy (the grouping key from send-to-market).
  // PostgREST can't `.or()` inside jsonb with equality, so we pull a wider
  // recent set and filter in JS — bounded by limit + order.
  const q = db
    .from("oems_order_audit")
    .select(
      "id, order_id, client_account, symbol, side, quantity, price_cents, status, source, payload, result_payload, created_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(500);

  const { data, error } = await q;
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({
        ok: true,
        rows: [],
        notice: "oems_order_audit table not migrated yet — apply 20260612000002_oems_order_audit.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const all = (data ?? []) as AuditRow[];
  const filtered = bookId
    ? all.filter((r) => {
        const p = r.payload ?? {};
        return (
          (typeof p.book_id === "string" && p.book_id === bookId) ||
          (typeof p.strategy === "string" && p.strategy === bookId)
        );
      })
    : all;

  const rows = filtered.map(mapRow);
  return NextResponse.json({ ok: true, rows, count: rows.length });
}
