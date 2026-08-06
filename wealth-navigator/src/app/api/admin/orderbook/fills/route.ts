import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/fills
 *
 * Mint OEM Phase B3 — automated fill ingest (mock endpoint). Accepts a
 * broker-style fill report keyed by order_id (a single book has many
 * order_ids — one per ISIN). For each fill:
 *   - updates `payload.filled` to the cumulative qty
 *   - updates `payload.avgPx` and `result_payload.avgFillPrice`
 *   - flips `status` to 'filled' when filled >= quantity, otherwise 'partial'
 *   - sets `status='rejected'` with a result_payload.rejectReason if qty <= 0
 *   - when all execution rows for the book are 'filled', the response
 *     advertises `book_ready_for_confirmation: true` so the UI can enable
 *     the Send Confirmation button.
 *   - when a row lands on 'filled' AND its payload is tagged uat_test=true
 *     (see client-order/route.ts), best-effort auto-settles it against
 *     MyMintAdmin's real settlement engine (closes the holding, credits the
 *     wallet, refunds reserve/residual) — see settleUatFill below. Never
 *     touches a live order: that engine independently re-verifies every
 *     targeted holding belongs to a test account before writing anything.
 *
 * Body: { order_id: string, fills: Array<{ symbol, qty, avg_fill_price_cents, timestamp }> }
 */

export const dynamic = "force-dynamic";

interface FillEntry {
  symbol: string;
  qty: number;
  avg_fill_price_cents: number;
  timestamp?: string;
}

interface AuditRow {
  id: string;
  order_id: string;
  symbol: string;
  quantity: number;
  status: string;
  side: string | null;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

interface SettlementResult {
  audit_id: string;
  attempted: boolean;
  ok: boolean;
  error?: string;
}

/**
 * Best-effort call to MyMintAdmin's real settlement engine
 * (api/orderbook/update-price.js) for a UAT self-fill — see this file's doc
 * comment. Never throws: a settlement-call failure must not fail the fill
 * itself, but IS surfaced in the response (never silently swallowed).
 */
async function settleUatFill(row: AuditRow, fillPriceCents: number): Promise<SettlementResult> {
  const payload = row.payload ?? {};
  const uatTest = payload.uat_test === true;
  const holdingId = typeof payload.holding_id === "string" ? payload.holding_id : "";
  if (!uatTest || !holdingId) {
    return { audit_id: row.id, attempted: false, ok: false };
  }
  const baseUrl = process.env.MYMINTADMIN_API_URL;
  const secret = process.env.OEM_UAT_SETTLEMENT_SECRET;
  if (!baseUrl || !secret) {
    return {
      audit_id: row.id,
      attempted: true,
      ok: false,
      error: "MYMINTADMIN_API_URL or OEM_UAT_SETTLEMENT_SECRET not configured",
    };
  }
  const side = String(row.side || "buy").toLowerCase();
  const updatePayload =
    side === "sell"
      ? { avg_exit: fillPriceCents }
      : { avg_fill: fillPriceCents, Fill_date: new Date().toISOString().slice(0, 10) };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/orderbook/update-price`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ ids: [holdingId], payload: updatePayload }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || body.error) {
      return { audit_id: row.id, attempted: true, ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { audit_id: row.id, attempted: true, ok: true };
  } catch (e) {
    return {
      audit_id: row.id,
      attempted: true,
      ok: false,
      error: e instanceof Error ? e.message : "settlement request failed",
    };
  }
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

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const orderId = typeof body.order_id === "string" ? body.order_id.trim() : "";
  const fills = Array.isArray(body.fills) ? (body.fills as FillEntry[]) : [];

  if (!orderId) return NextResponse.json({ ok: false, error: "order_id is required" }, { status: 400 });
  if (fills.length === 0)
    return NextResponse.json({ ok: false, error: "fills array is required" }, { status: 400 });

  const db = openInstitutional();
  if (!db) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  // Scope to this order/book AT THE DB LEVEL so the 500-row window covers the
  // relevant rows, not the newest 500 across ALL books (which dropped rows on a
  // busy shared audit table — same class as the execution-route vanish fix). The
  // JS filter downstream stays as defense-in-depth. PostgREST filters jsonb via
  // the ->> text accessor.
  const oid = orderId.replace(/[\\"]/g, "");
  const bookLookup = await db
    .from("oems_order_audit")
    .select("id, order_id, symbol, quantity, status, side, payload, result_payload")
    .or(`order_id.eq."${oid}",payload->>book_id.eq."${oid}",payload->>strategy.eq."${oid}"`)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (bookLookup.error) {
    if (isSupabaseSchemaMissing(bookLookup.error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "oems_order_audit table not migrated yet — apply 20260612000002_oems_order_audit.sql.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: bookLookup.error.message }, { status: 500 });
  }

  const allRows = (bookLookup.data ?? []) as AuditRow[];

  // Validate the order_id exists in the audit table. `order_id` in the
  // request is the book aggregate id (matches either order_id or payload.book_id
  // on the sent rows). For Phase B3 the BFF matches against `payload.book_id`
  // to scope the update to all rows of the book.
  const bookRows = allRows.filter((r) => {
    const p = r.payload ?? {};
    return (
      r.order_id === orderId ||
      (typeof p.book_id === "string" && p.book_id === orderId) ||
      (typeof p.strategy === "string" && p.strategy === orderId)
    );
  });

  if (bookRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: `No audit rows found for order_id/book_id "${orderId}".` },
      { status: 404 },
    );
  }

  // Build updates: one upsert per (symbol, audit row) match.
  const now = new Date().toISOString();
  const updates: Array<{
    id: string;
    payload: Record<string, unknown>;
    result_payload: Record<string, unknown>;
    status: string;
  }> = [];
  // Rows that land on "filled" this call, paired with the fill price that
  // filled them — settlement runs after the DB update succeeds, below.
  const toSettle: Array<{ row: AuditRow; fillPriceCents: number }> = [];

  for (const row of bookRows) {
    const fill = fills.find((f) => f.symbol === row.symbol);
    if (!fill) continue;
    const qty = Number(fill.qty) || 0;
    const avgFillCents = Math.round(Number(fill.avg_fill_price_cents) || 0);
    const avgFillRands = avgFillCents / 100;
    const totalQty = Number(row.quantity) || 0;

    // `payload.avgPx` / `result_payload.avgFillPrice` are read as CENTS
    // everywhere else (execution/route.ts, order-books/route.ts — matching
    // the real IRESS convention of quoting the JSE in cents), so they MUST be
    // written in cents here too, not rands. Storing rands here previously
    // made every UAT self-fill display ~100x too small (a R52.50 fill showed
    // as R0.53, with slip/P&L inheriting the same error downstream).
    const newPayload: Record<string, unknown> = {
      ...row.payload,
      filled: qty,
      avgPx: avgFillCents,
      lastFillAt: fill.timestamp ?? now,
    };

    const newResult: Record<string, unknown> = {
      ...row.result_payload,
      avgFillPrice: avgFillCents,
      slippageBps:
        num(row.payload?.limitPrice) != null
          ? Math.round(((num(row.payload?.limitPrice) ?? 0) - avgFillRands) * 10000) /
            Math.max(0.0001, num(row.payload?.limitPrice) ?? 0.0001)
          : null,
    };

    let newStatus = "partial";
    if (qty <= 0) {
      newStatus = "rejected";
      newResult.rejectReason = "Broker reported zero/negative quantity";
    } else if (qty >= totalQty) {
      newStatus = "filled";
    }

    updates.push({
      id: row.id,
      payload: newPayload,
      result_payload: newResult,
      status: newStatus,
    });

    if (newStatus === "filled") {
      toSettle.push({ row, fillPriceCents: Math.round(Number(fill.avg_fill_price_cents) || 0) });
    }
  }

  if (updates.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No matching symbols found in the fills payload for this book." },
      { status: 400 },
    );
  }

  // Apply via per-row updates (no upsert — we never insert; only update by id).
  // Use Promise.all so a single failure surfaces in the response.
  const results = await Promise.all(
    updates.map((u) =>
      db
        .from("oems_order_audit")
        .update({
          payload: u.payload,
          result_payload: u.result_payload,
          status: u.status,
          updated_at: now,
        })
        .eq("id", u.id),
    ),
  );

  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ ok: false, error: failed.error.message }, { status: 500 });
  }

  // Check if the entire book is now 100% filled → ready for confirmation.
  const bookId = orderId;
  const bookAfter = allRows
    .filter((r) => {
      const p = r.payload ?? {};
      return (
        r.order_id === bookId ||
        (typeof p.book_id === "string" && p.book_id === bookId) ||
        (typeof p.strategy === "string" && p.strategy === bookId)
      );
    })
    .map((r) => {
      const upd = updates.find((u) => u.id === r.id);
      return upd ? { ...r, status: upd.status } : r;
    });

  const allFilled = bookAfter.length > 0 && bookAfter.every((r) => r.status === "filled");

  // Auto-settle any row that just landed on "filled" and is tagged
  // uat_test=true — best-effort, after the DB update above has succeeded.
  // Never attempted for a live row (settleUatFill checks payload.uat_test
  // itself too — this is belt-and-braces, not the only guard).
  const settlements = await Promise.all(
    toSettle.map(({ row, fillPriceCents }) => settleUatFill(row, fillPriceCents)),
  );
  const attemptedSettlements = settlements.filter((s) => s.attempted);
  const failedSettlements = attemptedSettlements.filter((s) => !s.ok);

  return NextResponse.json({
    ok: true,
    updated: updates.length,
    book_id: bookId,
    book_ready_for_confirmation: allFilled,
    state: allFilled ? "READY_FOR_CONFIRMATION" : "WORKING",
    ...(attemptedSettlements.length
      ? {
          settlement: {
            attempted: attemptedSettlements.length,
            ok: attemptedSettlements.length - failedSettlements.length,
            failed: failedSettlements,
          },
        }
      : {}),
  });
}
