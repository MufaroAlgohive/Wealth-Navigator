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
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
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
    .select("id, order_id, symbol, quantity, status, payload, result_payload")
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

  for (const row of bookRows) {
    const fill = fills.find((f) => f.symbol === row.symbol);
    if (!fill) continue;
    const qty = Number(fill.qty) || 0;
    const avgFillRands = (Number(fill.avg_fill_price_cents) || 0) / 100;
    const totalQty = Number(row.quantity) || 0;

    const newPayload: Record<string, unknown> = {
      ...row.payload,
      filled: qty,
      avgPx: avgFillRands,
      lastFillAt: fill.timestamp ?? now,
    };

    const newResult: Record<string, unknown> = {
      ...row.result_payload,
      avgFillPrice: avgFillRands,
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

  return NextResponse.json({
    ok: true,
    updated: updates.length,
    book_id: bookId,
    book_ready_for_confirmation: allFilled,
    state: allFilled ? "READY_FOR_CONFIRMATION" : "WORKING",
  });
}
