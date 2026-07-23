import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/orderbook/order-books
 *
 * Lists CRM-style "order books" — one per "Send to Market" release batch
 * (see release-to-market/route.ts, which stamps `payload.order_book_seq`
 * onto every released row and inserts one `oems_order_book` row per
 * batch). `fully_filled` is computed HERE at read time (no cron/poller):
 * true iff the book has at least one member row and every member's
 * current `oems_order_audit.status` is exactly "filled" — a cancelled /
 * rejected / expired / failed member means the book never promotes.
 *
 * Returns: { ok, books: [{ sequence, released_at, released_by,
 *   total_count, filled_count, fully_filled }], notice? }, newest-first.
 */

export const dynamic = "force-dynamic";

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = openInstitutional();
  if (!db) {
    return NextResponse.json({ ok: true, books: [], notice: "INSTITUTIONAL database not configured." });
  }

  const { data: bookRows, error: bookErr } = await db
    .from("oems_order_book")
    .select("sequence, released_at, released_by, member_count")
    .order("sequence", { ascending: false });
  if (bookErr) {
    if (isSupabaseSchemaMissing(bookErr)) {
      return NextResponse.json({
        ok: true,
        books: [],
        notice: "oems_order_book table not migrated yet — apply 20260723000001_oems_order_book.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: bookErr.message }, { status: 500 });
  }
  if (!bookRows || bookRows.length === 0) {
    return NextResponse.json({ ok: true, books: [] });
  }

  const { data: memberRows, error: memberErr } = await db
    .from("oems_order_audit")
    .select("status, payload")
    .not("payload->>order_book_seq", "is", null);
  if (memberErr) {
    return NextResponse.json({ ok: false, error: memberErr.message }, { status: 500 });
  }

  const bySeq = new Map<number, { total: number; filled: number }>();
  for (const r of (memberRows ?? []) as Array<{ status: string; payload: Record<string, unknown> | null }>) {
    const rawSeq = r.payload?.order_book_seq;
    const seq = typeof rawSeq === "number" ? rawSeq : Number(rawSeq);
    if (!Number.isFinite(seq)) continue;
    const agg = bySeq.get(seq) ?? { total: 0, filled: 0 };
    agg.total += 1;
    if (r.status === "filled") agg.filled += 1;
    bySeq.set(seq, agg);
  }

  const books = (bookRows as Array<{ sequence: number; released_at: string; released_by: string | null; member_count: number }>).map(
    (b) => {
      const agg = bySeq.get(b.sequence) ?? { total: 0, filled: 0 };
      return {
        sequence: b.sequence,
        released_at: b.released_at,
        released_by: b.released_by,
        total_count: agg.total,
        filled_count: agg.filled,
        fully_filled: agg.total > 0 && agg.filled === agg.total,
      };
    },
  );

  return NextResponse.json({ ok: true, books });
}
