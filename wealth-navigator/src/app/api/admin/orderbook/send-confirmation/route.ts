import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { isUatEnv } from "@/lib/oems/uat-scope";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/send-confirmation
 *
 * Mint OEM Phase B3 — closes the loop on a basket. Two independent origins,
 * because "order" means a different physical row depending on where the
 * order came from:
 *
 *  - origin="oem" (default): the order lives in `oems_order_audit`. Looked
 *    up by order_id, confirmation is stamped onto that audit row.
 *  - origin="crm": the order is a legacy CRM/bond allocation that was NEVER
 *    written to oems_order_audit at all — it only exists as one element of
 *    `orderbook_email_runs.snapshot_rows` (a JSONB array). The affected
 *    holding(s) are identified by `source_ids`, which ARE `stock_holdings_c.id`
 *    directly (see MyMintAdmin's public/orderbook.html: "Pinned fresh orders
 *    (sourceId = stock_holdings_c.id)"). One order_id resolves to one
 *    snapshot row, which can carry either a single BND allocation or a whole
 *    strategy's worth of investor holdings — source_ids covers both:
 *    a single-element array for a direct order/allocation confirm, or
 *    an investor's full source_ids list for a per-investor confirm within a
 *    strategy order. Confirming this kind of order was previously impossible
 *    from here: the UI displayed a CRM settlement reference
 *    (e.g. "BND-20260727-4001") as the order's `order_id`, but that string
 *    was never an oems_order_audit.order_id, so every attempt 404'd.
 *
 * Both origins:
 *  1. Stamp confirmation metadata (who / when) onto the source row.
 *  2. Update RETAIL `stock_holdings_c.Fill_date` to today for the affected
 *     holding(s) so client P&L start date = execution date.
 *  3. Log the confirmation email intent (Resend dispatch is deferred; we
 *     `console.info` for the moment and surface `email: "logged"` in the
 *     response).
 *
 * Body (oem):  { order_id: string, book_id: string }
 * Body (crm):  { order_id: string, book_id: string, origin: "crm", source_ids: string[] }
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

const CRM_ARCHIVE_ID_RE = /^(\d{4}-\d{2}-\d{2})-(\d+)$/;

/** Mirrors order-books/route.ts's own `num()` — kept local to avoid coupling
 * this route's behaviour to that file's internals changing under it. */
function crmNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Mirrors order-books/route.ts's `crmMoney()` exactly — CRM snapshot rows
 * store money as either a raw number or a formatted "R 1,234.56" string. */
function crmMoneyValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v ?? "")
    .replace(/[^\d,.-]/g, "")
    .trim();
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

/** Bulk Fill_date update shared by both origins' holding-update step, with
 * the same UAT real-client protection both paths need. */
async function updateHoldingsFillDate(
  retail: SupabaseClient,
  ids: string[],
  today: string,
): Promise<{ updated: number; notice: string | null }> {
  if (ids.length === 0) return { updated: 0, notice: "No holding ids provided — Fill_date unchanged." };
  const { data: holds, error: holdsErr } = await retail
    .from("stock_holdings_c")
    .select("id, user_id")
    .in("id", ids)
    .eq("is_active", true);
  if (holdsErr) return { updated: 0, notice: `stock_holdings_c read failed: ${holdsErr.message}` };

  let holdingRows = (holds ?? []) as Array<{ id: string; user_id: string }>;
  let protectedReal = 0;
  if (isUatEnv() && holdingRows.length > 0) {
    const ownerIds = [...new Set(holdingRows.map((h) => h.user_id).filter(Boolean))];
    const { data: testRows } = await retail.from("profiles").select("id").eq("is_test", true).in("id", ownerIds);
    const testIds = new Set((testRows ?? []).map((r) => r.id as string));
    const before = holdingRows.length;
    holdingRows = holdingRows.filter((h) => testIds.has(h.user_id));
    protectedReal = before - holdingRows.length;
  }
  const protectedSuffix =
    protectedReal > 0 ? ` (${protectedReal} real client holding(s) protected — not touched during UAT)` : "";

  if (holdingRows.length === 0) {
    return {
      updated: 0,
      notice:
        protectedReal > 0
          ? `No test holdings matched${protectedSuffix} — Fill_date unchanged.`
          : "No matching stock_holdings_c rows — Fill_date unchanged.",
    };
  }

  const { error: upErr, count } = await retail
    .from("stock_holdings_c")
    .update({ Fill_date: today })
    .in(
      "id",
      holdingRows.map((h) => h.id),
    )
    .eq("is_active", true);
  if (upErr) return { updated: 0, notice: `Fill_date update failed: ${upErr.message}` };
  return {
    updated: count ?? holdingRows.length,
    notice: protectedSuffix ? `Fill_date updated for test holdings only${protectedSuffix}.` : null,
  };
}

/**
 * CRM-origin confirmation. The order lives entirely inside one element of
 * `orderbook_email_runs.snapshot_rows`, matched by order_id (the same
 * bndReference-or-sourceId derivation order-books/route.ts's crmMember()
 * uses to build BookMember.order_id, so the id the UI displays is always the
 * one this lookup searches for).
 */
async function handleCrmConfirmation(
  retail: SupabaseClient,
  params: { orderId: string; bookId: string; sourceIds: string[]; actorEmail: string },
): Promise<NextResponse> {
  const { orderId, bookId, sourceIds, actorEmail } = params;
  const match = bookId.match(CRM_ARCHIVE_ID_RE);
  if (!match) {
    return NextResponse.json(
      { ok: false, error: `Invalid CRM archive id "${bookId}" — expected YYYY-MM-DD-N.` },
      { status: 400 },
    );
  }
  const [, runDate, sequenceStr] = match;
  const sequence = Number(sequenceStr);

  const { data: run, error: runErr } = await retail
    .from("orderbook_email_runs")
    .select("run_date, sequence_number, snapshot_rows")
    .eq("run_date", runDate)
    .eq("sequence_number", sequence)
    .maybeSingle();
  if (runErr) return NextResponse.json({ ok: false, error: runErr.message }, { status: 500 });
  if (!run) {
    return NextResponse.json({ ok: false, error: `No CRM order book found for "${bookId}".` }, { status: 404 });
  }

  const rows = Array.isArray(run.snapshot_rows) ? (run.snapshot_rows as Array<Record<string, unknown>>) : [];
  const idx = rows.findIndex((r) => {
    const rowSourceId = typeof r.sourceId === "string" ? r.sourceId : "";
    const derivedOrderId = (typeof r.bndReference === "string" && r.bndReference) || rowSourceId;
    return derivedOrderId === orderId;
  });
  if (idx === -1) {
    return NextResponse.json(
      { ok: false, error: `No snapshot row found for order "${orderId}" in book "${bookId}".` },
      { status: 404 },
    );
  }
  const row = rows[idx];
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `No snapshot row found for order "${orderId}" in book "${bookId}".` },
      { status: 404 },
    );
  }

  // Same "filled" derivation order-books/route.ts's crmMember() uses to
  // compute BookMember.status — keep them in lockstep, or the Send Confirm
  // button and this endpoint's own filled-check could disagree.
  const avgFill = crmNum(row.avgFillNumber) ?? crmMoneyValue(row.avgFill);
  if (!(avgFill != null && avgFill > 0)) {
    return NextResponse.json({ ok: false, error: "Order is not filled yet." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Stamp confirmation metadata onto just this one snapshot row. This is a
  // read-modify-write over the WHOLE book's snapshot_rows array in one
  // UPDATE -- two admins confirming two different rows of the same book at
  // the same instant could race and one write could be lost. Same
  // granularity every other snapshot_rows mutation in this table already has
  // (close-book.ts's closed_at, orderbook.html's per-row cleanup-delete);
  // simultaneous confirms on the same book are rare enough in practice that
  // matching the existing pattern here beats inventing per-row locking.
  const sentBy = Array.isArray(row.confirmationSentBy) ? row.confirmationSentBy : [];
  const updatedRows = rows.map((r, i) =>
    i === idx
      ? {
          ...r,
          confirmationSentAt: now,
          confirmationSentBy: actorEmail,
          // Preserve a history trail if this row gets confirmed more than
          // once (e.g. investor-by-investor within a strategy order).
          confirmationHistory: [...sentBy, { at: now, by: actorEmail, source_ids: sourceIds }],
        }
      : r,
  );
  const { error: updateErr } = await retail
    .from("orderbook_email_runs")
    .update({ snapshot_rows: updatedRows })
    .eq("run_date", runDate)
    .eq("sequence_number", sequence);
  if (updateErr) return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });

  // source_ids ARE stock_holdings_c.id directly -- no strategy/security
  // lookup needed, this targets the exact holding row(s) the order was
  // placed against. Falls back to the row's own top-level sourceId when the
  // caller didn't supply any (a direct order/allocation confirm with no
  // investor scoping).
  const rowSourceId = typeof row.sourceId === "string" ? row.sourceId : null;
  const idsToUpdate = sourceIds.length > 0 ? sourceIds : rowSourceId ? [rowSourceId] : [];
  const { updated: holdingsUpdated, notice: holdingsNotice } = await updateHoldingsFillDate(retail, idsToUpdate, today);

  // eslint-disable-next-line no-console
  console.info(
    `[orderbook/send-confirmation] CRM order=${orderId} book=${bookId} source_ids=${idsToUpdate.join(",")} confirmation_dispatched by=${actorEmail} at=${now}`,
  );

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    book_id: bookId,
    holdings_updated: holdingsUpdated,
    holdings_notice: holdingsNotice,
    confirmation_sent_at: now,
    email: "logged",
  });
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
  const orderId = typeof body.order_id === "string" ? body.order_id.trim() : "";
  const bookId = typeof body.book_id === "string" ? body.book_id.trim() : "";
  const origin = body.origin === "crm" ? "crm" : "oem";
  const sourceIds = Array.isArray(body.source_ids)
    ? body.source_ids.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : typeof body.source_id === "string" && body.source_id.trim()
      ? [body.source_id.trim()]
      : [];

  if (!orderId) {
    return NextResponse.json({ ok: false, error: "order_id is required" }, { status: 400 });
  }

  if (origin === "crm") {
    if (!bookId) {
      return NextResponse.json({ ok: false, error: "book_id is required for a CRM order" }, { status: 400 });
    }
    const retail = openRetail();
    if (!retail) {
      return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
    }
    return handleCrmConfirmation(retail, { orderId, bookId, sourceIds, actorEmail: auth.ctx.email ?? "" });
  }

  const institutional = openInstitutional();
  if (!institutional) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  // Pull the audit row for this order_id
  const v = orderId.replace(/[\\"]/g, ""); // neutralise PostgREST filter metachars
  const { data: rows, error: rowsErr } = await institutional
    .from("oems_order_audit")
    .select("id, order_id, symbol, quantity, status, payload, result_payload")
    .eq("order_id", v)
    .order("updated_at", { ascending: false })
    .limit(1);

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
  const orderRow = all[0];
  if (!orderRow) {
    return NextResponse.json(
      { ok: false, error: `No execution row found for order_id "${orderId}".` },
      { status: 404 },
    );
  }

  if (orderRow.status !== "filled") {
    return NextResponse.json(
      {
        ok: false,
        error: `Order is not filled. Current status is ${orderRow.status}.`,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Stamp confirmation metadata onto the audit row.
  const { error: updateErr } = await institutional
    .from("oems_order_audit")
    .update({
      result_payload: {
        ...orderRow.result_payload,
        confirmation_sent_at: now,
        confirmation_sent_by: auth.ctx.email,
      },
      updated_at: now,
    })
    .eq("id", orderRow.id);

  if (updateErr) {
    return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
  }

  // Update RETAIL `stock_holdings_c.Fill_date` so client P&L start = today.
  let holdingsUpdated = 0;
  let holdingsNotice: string | null = null;
  const retail = openRetail();
  if (retail && bookId) {
    try {
      // stock_holdings_c.security_id is a UUID FK into securities_c.id, never
      // the ticker string oems_order_audit.symbol carries (e.g. "NED.JO") --
      // comparing them directly can never match a row. Resolve the ticker to
      // its securities_c.id first, the same join every other reader in this
      // repo does (see api/admin/studio, api/admin/orderbook/execution).
      const { data: security, error: secErr } = await retail
        .from("securities_c")
        .select("id")
        .eq("symbol", orderRow.symbol)
        .maybeSingle();

      if (secErr) {
        holdingsNotice = `securities_c lookup failed: ${secErr.message}`;
      } else if (!security) {
        holdingsNotice = `No securities_c row for symbol "${orderRow.symbol}" — Fill_date unchanged.`;
      } else {
        const { data: holds, error: holdsErr } = await retail
          .from("stock_holdings_c")
          .select("id")
          .eq("strategy_name_snapshot", bookId)
          .eq("security_id", security.id)
          .eq("is_active", true);
        if (holdsErr) {
          holdingsNotice = `stock_holdings_c read failed: ${holdsErr.message}`;
        } else {
          const ids = ((holds ?? []) as Holding[]).map((h) => h.id);
          const result = await updateHoldingsFillDate(retail, ids, today);
          holdingsUpdated = result.updated;
          holdingsNotice = result.notice ?? (ids.length === 0 ? "No stock_holdings_c rows matched the order — Fill_date unchanged." : null);
        }
      }
    } catch (e) {
      holdingsNotice = `RETAIL holdings update failed: ${(e as Error).message}`;
    }
  } else {
    if (!bookId) {
      holdingsNotice = "No bookId provided — Fill_date unchanged.";
    } else {
      holdingsNotice = "RETAIL database not configured — Fill_date unchanged.";
    }
  }

  // Email intent is logged for now (Resend dispatch deferred).
  // eslint-disable-next-line no-console
  console.info(
    `[orderbook/send-confirmation] order=${orderId} book=${bookId} confirmation_dispatched by=${auth.ctx.email} at=${now}`,
  );

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    book_id: bookId,
    holdings_updated: holdingsUpdated,
    holdings_notice: holdingsNotice,
    confirmation_sent_at: now,
    email: "logged",
  });
}
