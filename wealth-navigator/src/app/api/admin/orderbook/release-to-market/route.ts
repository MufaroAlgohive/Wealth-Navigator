/**
 * POST /api/admin/orderbook/release-to-market
 *
 * Releases parked orders (written by `client-order/route.ts` for mint-
 * triggered client buys/sells) to the worker/IRESS — the "Send to Market"
 * gate button in `UatBasketBook`. Until this is called, parked rows have
 * had zero broker contact.
 *
 * Body: { book_id?: string } — optional, narrows release to one book id.
 * Omitted (the v1 button's behavior) releases every currently-parked row.
 *
 * For each parked row, `releaseOrder()` (`@/lib/orders`) re-derives a fresh
 * preflight from the row's own stored columns and, only on pass, fans out
 * to the worker exactly as the immediate-send path already does. A row
 * that fails preflight on release is left `parked` (not rejected) so the
 * next click retries it — this is what makes "release" a completeness
 * guarantee rather than a one-shot fire-and-maybe-drop.
 *
 * Auth: admin session + `orderbook.send_to_market` — the same permission
 * every other send-to-broker action already requires (`uat-order`,
 * `send-to-market`, `amend`, `cancel`).
 *
 * CRM-style order-book numbering (2026-07-23): everything released
 * together in ONE call of this route is "one order book" — after the
 * release loop, a new `oems_order_book` row is assigned the next
 * sequence number and every successfully-released row is stamped with
 * `payload.order_book_seq` (merge-write, mirrors the existing
 * `payload.book_id` convention — see `oems_order_book`'s own comment).
 * Book-row creation is strictly best-effort AFTER the releases: a
 * numbering failure must never roll back or hide a real send to the
 * worker, so any failure here only sets `book_warning` on the response.
 */

import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { openSupabaseClients, releaseOrder } from "@/lib/orders";
import { SEND_TO_MARKET_LOCKED, SEND_TO_MARKET_LOCKED_MESSAGE } from "@/lib/orders/send-to-market-lock";

export const dynamic = "force-dynamic";

const BROKER = process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (SEND_TO_MARKET_LOCKED) {
    return NextResponse.json({ ok: false, error: SEND_TO_MARKET_LOCKED_MESSAGE }, { status: 423 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bookId = typeof body.book_id === "string" && body.book_id.trim() ? body.book_id.trim() : null;

  let supabase;
  try {
    supabase = await openSupabaseClients();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Supabase not configured" },
      { status: 503 },
    );
  }

  let query = supabase.institutional
    .from("oems_order_audit")
    .select("id, order_id, payload")
    .eq("status", "parked");
  if (bookId) query = query.eq("payload->>book_id", bookId);

  const { data: parkedRows, error: queryErr } = await query;
  if (queryErr) {
    return NextResponse.json({ ok: false, error: `Failed to load parked orders: ${queryErr.message}` }, { status: 500 });
  }
  if (!parkedRows || parkedRows.length === 0) {
    return NextResponse.json({ ok: true, released: 0, failed: 0, results: [], notice: "No parked orders to release." });
  }

  // Sequential, not Promise.all — mirrors send-to-market's own bulk-dispatch
  // convention of not hammering the worker's single IRESS license seat.
  const results: Array<{
    id: string;
    order_id: string | null;
    ok: boolean;
    iressOrderNumber?: string;
    status?: string;
    error?: string;
    code?: string;
  }> = [];
  for (const row of parkedRows) {
    const r = await releaseOrder(supabase, row.id as string, { broker: BROKER });
    results.push({
      id: row.id as string,
      order_id: row.order_id as string | null,
      ok: r.ok,
      iressOrderNumber: r.iress_order_number,
      status: r.status,
      error: r.ok ? undefined : (r.error ?? r.preflight?.message),
      code: r.ok ? undefined : (r.preflight?.code ?? r.worker_code),
    });
  }

  // ── CRM-style order-book numbering ──────────────────────────────────
  // Best-effort, strictly AFTER the releases above. A numbering failure
  // must never affect the response's released/failed accounting.
  const releasedRows = parkedRows.filter((row) => results.find((r) => r.id === row.id)?.ok);
  let orderBookSeq: number | null = null;
  let bookWarning: string | undefined;
  if (releasedRows.length > 0) {
    const assignSequence = async (): Promise<number | null> => {
      const { data: last } = await supabase.institutional
        .from("oems_order_book")
        .select("sequence")
        .order("sequence", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextSeq = ((last as { sequence?: number } | null)?.sequence ?? 0) + 1;
      const { error: insErr } = await supabase.institutional.from("oems_order_book").insert({
        sequence: nextSeq,
        released_by: auth.ctx.email ?? null,
        member_count: releasedRows.length,
      });
      if (!insErr) return nextSeq;
      // Postgres unique_violation — another release raced us for this
      // sequence number. Re-read max and retry exactly once.
      if ((insErr as { code?: string }).code === "23505") {
        const { data: last2 } = await supabase.institutional
          .from("oems_order_book")
          .select("sequence")
          .order("sequence", { ascending: false })
          .limit(1)
          .maybeSingle();
        const retrySeq = ((last2 as { sequence?: number } | null)?.sequence ?? 0) + 1;
        const { error: retryErr } = await supabase.institutional.from("oems_order_book").insert({
          sequence: retrySeq,
          released_by: auth.ctx.email ?? null,
          member_count: releasedRows.length,
        });
        if (!retryErr) return retrySeq;
      }
      return null;
    };

    orderBookSeq = await assignSequence();
    if (orderBookSeq == null) {
      bookWarning = "Orders were released successfully, but this batch could not be numbered as an order book this round.";
    } else {
      for (const row of releasedRows) {
        const prevPayload = (row as { payload?: Record<string, unknown> | null }).payload ?? {};
        await supabase.institutional
          .from("oems_order_audit")
          .update({ payload: { ...prevPayload, order_book_seq: orderBookSeq } })
          .eq("id", row.id as string);
      }
    }
  }

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    released: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    order_book_seq: orderBookSeq,
    ...(bookWarning ? { book_warning: bookWarning } : {}),
  });
}
