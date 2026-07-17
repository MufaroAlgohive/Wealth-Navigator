import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { isUatEnv } from "@/lib/oems/uat-scope";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/send-confirmation
 *
 * Mint OEM Phase B3 — closes the loop on a basket. Validates that every
 * execution row tied to the book_id is `filled`, then:
 *
 *  1. Stamps `result_payload.confirmation_sent_at` and the desk lead's email
 *     onto every audit row so the trade-confirmation timeline is queryable.
 *  2. Updates RETAIL `stock_holdings_c.Fill_date` to today for every holding
 *     in the book so client P&L start date = execution date (Day-1 P&L
 *     begins from this moment).
 *  3. Logs the confirmation email intent (Resend dispatch is deferred; we
 *     `console.info` for the moment and surface `email: "logged"` in the
 *     response).
 *
 * Body: { book_id: string }
 *
 * Gate: `orderbook/send_confirmation` permission (tri-state: blocked /
 * test_only / full). The button is also DISABLED on the client until the
 * fills endpoint reports `book_ready_for_confirmation: true`.
 */

export const dynamic = "force-dynamic";

interface AuditRow {
  id: string;
  order_id: string;
  symbol: string;
  quantity: number;
  status: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

interface Holding {
  id: string;
  user_id: string;
  security_id: string;
  strategy_name_snapshot: string | null;
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

function openRetail(): SupabaseClient | null {
  try {
    return createRetailServiceRoleClient();
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
  if (!can(auth.ctx, "orderbook", "send_confirmation")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bookId = typeof body.book_id === "string" ? body.book_id.trim() : "";
  if (!bookId) return NextResponse.json({ ok: false, error: "book_id is required" }, { status: 400 });

  const institutional = openInstitutional();
  if (!institutional) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  // Pull the audit rows for THIS book. Scope to the book AT THE DB LEVEL
  // (payload.book_id / payload.strategy / order_id) BEFORE the 500-row window so
  // the "100% filled" gate below sees the COMPLETE book, not the newest 500 rows
  // across ALL books. On a busy shared audit table the un-scoped scan could
  // truncate this book's rows out of the window, letting a not-fully-filled book
  // pass the fill gate and then stamp real client Fill_date. Mirrors the DB-level
  // scoping in /api/admin/orderbook/execution; the JS filter below stays as
  // defense-in-depth. PostgREST filters jsonb via the `->>` text accessor.
  const v = bookId.replace(/[\\"]/g, ""); // neutralise PostgREST filter metachars
  const { data: rows, error: rowsErr } = await institutional
    .from("oems_order_audit")
    .select("id, order_id, symbol, quantity, status, payload, result_payload")
    .or(`payload->>book_id.eq."${v}",payload->>strategy.eq."${v}",order_id.eq."${v}"`)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (rowsErr) {
    if (isSupabaseSchemaMissing(rowsErr)) {
      return NextResponse.json(
        {
          ok: false,
          error: "oems_order_audit table not migrated yet — apply 20260612000002_oems_order_audit.sql.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: rowsErr.message }, { status: 500 });
  }

  const all = (rows ?? []) as AuditRow[];
  const bookRows = all.filter((r) => {
    const p = r.payload ?? {};
    return (
      r.order_id === bookId ||
      (typeof p.book_id === "string" && p.book_id === bookId) ||
      (typeof p.strategy === "string" && p.strategy === bookId)
    );
  });

  if (bookRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: `No execution rows found for book_id "${bookId}".` },
      { status: 404 },
    );
  }

  const notFilled = bookRows.filter((r) => r.status !== "filled");
  if (notFilled.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Book is not 100% filled. ${notFilled.length} of ${bookRows.length} execution rows still working.`,
        unfilled: notFilled.map((r) => ({ order_id: r.order_id, symbol: r.symbol, status: r.status })),
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Stamp confirmation metadata onto every audit row.
  const updates = await Promise.all(
    bookRows.map((r) =>
      institutional
        .from("oems_order_audit")
        .update({
          result_payload: {
            ...r.result_payload,
            confirmation_sent_at: now,
            confirmation_sent_by: auth.ctx.email,
          },
          updated_at: now,
        })
        .eq("id", r.id),
    ),
  );
  const failed = updates.find((u) => u.error);
  if (failed?.error) {
    return NextResponse.json({ ok: false, error: failed.error.message }, { status: 500 });
  }

  // Update RETAIL `stock_holdings_c.Fill_date` so client P&L start = today.
  let holdingsUpdated = 0;
  let holdingsNotice: string | null = null;
  const retail = openRetail();
  if (retail) {
    try {
      const { data: holds, error: holdsErr } = await retail
        .from("stock_holdings_c")
        .select("id, user_id, security_id, strategy_name_snapshot")
        .eq("strategy_name_snapshot", bookId)
        .eq("is_active", true);

      if (holdsErr) {
        holdingsNotice = `stock_holdings_c read failed: ${holdsErr.message}`;
      } else {
        let holdingRows = (holds ?? []) as Holding[];
        // CLIENT-DATA GUARD (UAT phase): Fill_date is a real-money field (it sets
        // the client P&L start date). During the UAT phase never mutate a real
        // (is_test != true) client's holding — restrict the write to test
        // clients and report how many real holdings were protected. Inert once
        // the deployment is confidently on prod (isUatEnv() === false).
        let protectedReal = 0;
        if (isUatEnv() && holdingRows.length > 0) {
          const ownerIds = [...new Set(holdingRows.map((h) => h.user_id).filter(Boolean))];
          const { data: testRows } = await retail
            .from("profiles")
            .select("id")
            .eq("is_test", true)
            .in("id", ownerIds);
          const testIds = new Set((testRows ?? []).map((r) => r.id as string));
          const before = holdingRows.length;
          holdingRows = holdingRows.filter((h) => testIds.has(h.user_id));
          protectedReal = before - holdingRows.length;
        }
        const protectedSuffix =
          protectedReal > 0
            ? ` (${protectedReal} real client holding(s) protected — not touched during UAT)`
            : "";
        if (holdingRows.length > 0) {
          const { error: upErr, count } = await retail
            .from("stock_holdings_c")
            .update({ Fill_date: today })
            .in(
              "id",
              holdingRows.map((h) => h.id),
            )
            .eq("is_active", true);
          if (upErr) holdingsNotice = `Fill_date update failed: ${upErr.message}`;
          else {
            holdingsUpdated = count ?? holdingRows.length;
            if (protectedSuffix) holdingsNotice = `Fill_date updated for test holdings only${protectedSuffix}.`;
          }
        } else if (protectedReal > 0) {
          holdingsNotice = `No test holdings in this book${protectedSuffix} — Fill_date unchanged.`;
        } else {
          holdingsNotice = "No stock_holdings_c rows matched the book — Fill_date unchanged.";
        }
      }
    } catch (e) {
      holdingsNotice = `RETAIL holdings update failed: ${(e as Error).message}`;
    }
  } else {
    holdingsNotice = "RETAIL database not configured — Fill_date unchanged.";
  }

  // Email intent is logged for now (Resend dispatch deferred).
  // eslint-disable-next-line no-console
  console.info(
    `[orderbook/send-confirmation] book=${bookId} confirmation_dispatched by=${auth.ctx.email} at=${now} client_count=${bookRows.length}`,
  );

  return NextResponse.json({
    ok: true,
    book_id: bookId,
    confirmed_count: bookRows.length,
    holdings_updated: holdingsUpdated,
    holdings_notice: holdingsNotice,
    confirmation_sent_at: now,
    email: "logged",
  });
}
