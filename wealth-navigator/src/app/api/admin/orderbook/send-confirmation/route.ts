import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { buildTradeConfirmationHtml, sendEmail } from "@/lib/admin/email";
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
 *  3. Send a real MINT-branded trade-confirmation email (same Resend
 *     infrastructure + `buildTradeConfirmationHtml` template `manual-fill`
 *     already uses successfully) to every distinct client affected by the
 *     book — a strategy-wide order can touch many clients, so this sends
 *     one email per client, not one generic email. Email failures (bad/
 *     missing address, Resend outage) are caught per-client and never block
 *     or roll back the confirmation-stamping / Fill_date logic above; the
 *     outcome is surfaced via `confirmation_email` (aggregate status) and
 *     `confirmation_email_summary` (`{ sent, skipped, failed }` counts).
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
  side: string | null;
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

/** One distinct client whose stock_holdings_c row(s) actually had Fill_date
 * stamped by updateHoldingsFillDate — i.e. AFTER the UAT real-client guard
 * has already excluded anyone who must not be touched. `quantity` sums that
 * client's matched holding rows, giving each client's own trade-confirmation
 * email an accurate per-client fill size rather than the order's total. */
interface AffectedClient {
  userId: string;
  quantity: number;
}

/** Bulk Fill_date update shared by both origins' holding-update step, with
 * the same UAT real-client protection both paths need. Also returns the
 * distinct clients actually touched, so the caller can email exactly the
 * people whose holdings were updated (never a UAT-protected real client). */
async function updateHoldingsFillDate(
  retail: SupabaseClient,
  ids: string[],
  today: string,
): Promise<{ updated: number; notice: string | null; clients: AffectedClient[] }> {
  if (ids.length === 0) return { updated: 0, notice: "No holding ids provided — Fill_date unchanged.", clients: [] };
  const { data: holds, error: holdsErr } = await retail
    .from("stock_holdings_c")
    .select("id, user_id, quantity")
    .in("id", ids)
    .eq("is_active", true);
  if (holdsErr) return { updated: 0, notice: `stock_holdings_c read failed: ${holdsErr.message}`, clients: [] };

  let holdingRows = (holds ?? []) as Array<{ id: string; user_id: string; quantity: number | null }>;
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
      clients: [],
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
  if (upErr) return { updated: 0, notice: `Fill_date update failed: ${upErr.message}`, clients: [] };

  const byClient = new Map<string, number>();
  for (const h of holdingRows) {
    if (!h.user_id) continue;
    byClient.set(h.user_id, (byClient.get(h.user_id) ?? 0) + (Number(h.quantity) || 0));
  }

  return {
    updated: count ?? holdingRows.length,
    notice: protectedSuffix ? `Fill_date updated for test holdings only${protectedSuffix}.` : null,
    clients: [...byClient.entries()].map(([userId, quantity]) => ({ userId, quantity })),
  };
}

/** Overall status string for the response — "sent" if at least one client
 * got their email, "failed" if nobody got one but at least one attempt
 * errored, "skipped" only when there was nothing to send (no clients, or
 * every affected client has no email on file). Mirrors the per-request
 * `confirmation_email` field manual-fill/route.ts already returns, extended
 * here to an aggregate across however many clients this book/order touched. */
function summarizeEmailStatus(s: { sent: number; skipped: number; failed: number }): "sent" | "skipped" | "failed" {
  if (s.sent > 0) return "sent";
  if (s.failed > 0) return "failed";
  return "skipped";
}

/** Sends one real trade-confirmation email per affected client — same
 * Resend call + `buildTradeConfirmationHtml` template manual-fill/route.ts
 * already uses successfully. Deliberately best-effort per client: a bad
 * address or a Resend outage for one client must never stop the others, and
 * must never roll back the Fill_date/confirmation-stamp work that already
 * happened above this call. */
async function sendConfirmationEmails(
  retail: SupabaseClient,
  params: {
    clients: AffectedClient[];
    action: "Buy" | "Sell";
    symbol: string;
    avgPriceRands: number;
    source: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ sent: number; skipped: number; failed: number }> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const client of params.clients) {
    try {
      const { data: profs } = await retail
        .from("profiles")
        .select("email, first_name, mint_number")
        .eq("id", client.userId)
        .limit(1);
      const profile = profs?.[0] as { email?: string; first_name?: string; mint_number?: string } | undefined;
      if (!profile?.email) {
        skipped += 1;
        continue;
      }
      // Same client-facing reference convention manual-fill/route.ts uses:
      // {mint_number}-{bare ticker}, falling back to the raw symbol only when
      // mint_number is missing so the reference is never blank.
      const bareSymbol = params.symbol.replace(/\.(JO|JSE)$/i, "");
      const reference = profile.mint_number ? `${profile.mint_number}-${bareSymbol}` : params.symbol;
      await sendEmail({
        to: profile.email,
        subject: `Trade confirmed — ${params.symbol}`,
        html: buildTradeConfirmationHtml({
          firstName: profile.first_name,
          action: params.action,
          symbol: params.symbol,
          orderId: reference,
          quantity: client.quantity,
          avgPriceRands: params.avgPriceRands,
        }),
        emailType: "trade_confirmation",
        source: params.source,
        metadata: { ...params.metadata, user_id: client.userId },
      });
      sent += 1;
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[orderbook/send-confirmation] trade confirmation email failed for user=${client.userId} (non-fatal):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return { sent, skipped, failed };
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
  const {
    updated: holdingsUpdated,
    notice: holdingsNotice,
    clients,
  } = await updateHoldingsFillDate(retail, idsToUpdate, today);

  // CRM snapshot rows never went through oems_order_audit, so symbol/side/
  // qty live under different field names than the OEM path — mirrors
  // order-books/route.ts's own crmMember() field derivation exactly so the
  // email matches what the UI already shows for this row. avgFill (computed
  // above for the fill-gate) is already in RANDS in a CRM snapshot row
  // (crmMoneyValue/crmNum), unlike the OEM path's audit-row CENTS convention
  // — no /100 conversion here.
  const symbol =
    (typeof row.ticker === "string" && row.ticker) || (typeof row.instrumentName === "string" && row.instrumentName) || orderId;
  const action: "Buy" | "Sell" = (typeof row.side === "string" ? row.side : "BUY").toUpperCase() === "SELL" ? "Sell" : "Buy";

  let emailSummary = { sent: 0, skipped: 0, failed: 0 };
  if (clients.length > 0) {
    emailSummary = await sendConfirmationEmails(retail, {
      clients,
      action,
      symbol,
      avgPriceRands: avgFill,
      source: "orderbook_send_confirmation_crm",
      metadata: { order_id: orderId, book_id: bookId, origin: "crm" },
    });
  }
  const confirmationEmail = summarizeEmailStatus(emailSummary);

  // eslint-disable-next-line no-console
  console.info(
    `[orderbook/send-confirmation] CRM order=${orderId} book=${bookId} source_ids=${idsToUpdate.join(",")} confirmation_dispatched by=${actorEmail} at=${now} email=${confirmationEmail} (sent=${emailSummary.sent} skipped=${emailSummary.skipped} failed=${emailSummary.failed})`,
  );

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    book_id: bookId,
    holdings_updated: holdingsUpdated,
    holdings_notice: holdingsNotice,
    confirmation_sent_at: now,
    confirmation_email: confirmationEmail,
    confirmation_email_summary: emailSummary,
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
    .select("id, order_id, symbol, side, quantity, status, payload, result_payload")
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
  let emailSummary = { sent: 0, skipped: 0, failed: 0 };
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

          if (result.clients.length > 0) {
            // oems_order_audit stores fill price in CENTS (payload.avgPx /
            // result_payload.avgFillPrice) -- same convention order-books/
            // route.ts and manual-fill/route.ts both read it under.
            const payload = (orderRow.payload ?? {}) as Record<string, unknown>;
            const resultPayload = (orderRow.result_payload ?? {}) as Record<string, unknown>;
            const avgFillCents = Number(payload.avgPx) || Number(resultPayload.avgFillPrice) || 0;
            const avgPriceRands = avgFillCents > 0 ? avgFillCents / 100 : 0;
            const action: "Buy" | "Sell" = (orderRow.side ?? "buy").toUpperCase() === "SELL" ? "Sell" : "Buy";
            emailSummary = await sendConfirmationEmails(retail, {
              clients: result.clients,
              action,
              symbol: String(orderRow.symbol ?? ""),
              avgPriceRands,
              source: "orderbook_send_confirmation",
              metadata: { order_id: orderId, book_id: bookId, origin: "oem" },
            });
          }
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

  const confirmationEmail = summarizeEmailStatus(emailSummary);

  // eslint-disable-next-line no-console
  console.info(
    `[orderbook/send-confirmation] order=${orderId} book=${bookId} confirmation_dispatched by=${auth.ctx.email} at=${now} email=${confirmationEmail} (sent=${emailSummary.sent} skipped=${emailSummary.skipped} failed=${emailSummary.failed})`,
  );

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    book_id: bookId,
    holdings_updated: holdingsUpdated,
    holdings_notice: holdingsNotice,
    confirmation_sent_at: now,
    confirmation_email: confirmationEmail,
    confirmation_email_summary: emailSummary,
  });
}
