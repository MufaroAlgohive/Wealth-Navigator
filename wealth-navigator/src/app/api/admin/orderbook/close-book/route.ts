import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { sendEmail } from "@/lib/admin/email";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";
import { toMember, type MemberAuditRow, type BookMember } from "@/app/api/admin/orderbook/order-books/route";

/**
 * POST /api/admin/orderbook/close-book
 *
 * "Move to Closed Book" — the CRM's shared (not per-browser) archival step
 * (public/orderbook.html: orderbook_email_runs.closed_at). Closing a book:
 *   1. Emails a CSV of the book's fills to every admin_team member with
 *      permissions.notifications.csv_exports === true (same recipient rule
 *      as MyMintAdmin's sendOrderbookCsvEmail) via Resend.
 *   2. Stamps oems_order_book.closed_at/closed_by regardless of whether the
 *      email succeeded — closing is not blocked on email delivery. The
 *      email outcome is tracked separately (email_status/email_error) so a
 *      failed send shows a retryable "Email Failed" chip, exactly like the
 *      CRM's archive list.
 *
 * Body: { sequence: number, closed?: boolean, retry_email?: boolean }
 *   - closed=false reopens the book (clears closed_at) and does not touch
 *     the email.
 *   - retry_email=true (closed already true) re-sends the CSV without
 *     re-stamping closed_at/closed_by.
 *
 * Gate: `orderbook.send_to_market` — same as every other archive-mutating
 * action on this page.
 */

export const dynamic = "force-dynamic";

function toCsv(members: BookMember[]): string {
  const head = ["Order", "Client", "Symbol", "Side", "Qty", "Filled", "Type", "Limit", "Avg Fill", "Value (R)", "Venue", "State", "Filled At"];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = members.map((m) =>
    [
      m.order_id ?? "", m.client_account ?? "", m.symbol ?? "", m.side, m.qty, m.filled, m.order_type,
      m.limit_price_rands?.toFixed(2) ?? "", m.avg_fill_price_rands?.toFixed(2) ?? "", m.value_rands?.toFixed(2) ?? "",
      m.venue ?? "", m.status, m.filled_at ?? "",
    ].map(esc).join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sequence = Number(body.sequence);
  if (!Number.isFinite(sequence)) {
    return NextResponse.json({ ok: false, error: "sequence is required" }, { status: 400 });
  }
  const closed = body.closed !== false;
  const retryEmail = body.retry_email === true;

  let institutional: ReturnType<typeof createInstitutionalServiceRoleClient>;
  try {
    institutional = createInstitutionalServiceRoleClient();
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Supabase not configured" }, { status: 503 });
  }

  if (!closed) {
    // Reopen: clear closed_at only. Email status is left as-is (history).
    const { error } = await institutional
      .from("oems_order_book")
      .update({ closed_at: null, closed_by: null })
      .eq("sequence", sequence);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, sequence, closed: false });
  }

  // Send (or re-send) the CSV confirmation email — best-effort, never blocks closing.
  let emailStatus: "sent" | "failed" = "failed";
  let emailError: string | null = null;
  try {
    const { data: memberRows, error: memberErr } = await institutional
      .from("oems_order_audit")
      .select(
        "id, order_id, client_account, symbol, side, quantity, price_cents, status, source, payload, result_payload, updated_at",
      )
      .eq("payload->>order_book_seq", String(sequence));
    if (memberErr) throw new Error(memberErr.message);
    const members = ((memberRows ?? []) as MemberAuditRow[]).map(toMember);

    let retail: ReturnType<typeof createRetailServiceRoleClient> | null;
    try {
      retail = createRetailServiceRoleClient();
    } catch {
      retail = null;
    }
    let recipients: string[] = [];
    if (retail) {
      const { data: team } = await retail.from("admin_team").select("email, permissions");
      recipients = ((team ?? []) as Array<{ email: string | null; permissions: Record<string, unknown> | null }>)
        .filter((r) => {
          const notifs = (r.permissions?.notifications ?? {}) as Record<string, unknown>;
          return !!r.email && notifs.csv_exports === true;
        })
        .map((r) => r.email as string);
    }
    if (recipients.length === 0) {
      throw new Error("No admin_team recipients have notifications.csv_exports enabled.");
    }

    const csv = toCsv(members);
    const csvB64 = Buffer.from(csv, "utf8").toString("base64");
    await sendEmail({
      to: recipients,
      subject: `Order Book ${sequence} — ${members.length} fill${members.length === 1 ? "" : "s"}`,
      html: `<p style="font-family:sans-serif;font-size:13px;color:#111;">Order Book ${sequence} closed. ${members.length} execution${members.length === 1 ? "" : "s"} attached as CSV.</p>`,
      emailType: "orderbook_csv",
      source: "close-book",
      metadata: { sequence, member_count: members.length, closed_by: auth.ctx.email },
      attachments: [{ filename: `order-book-${sequence}.csv`, content: csvB64 }],
    });
    emailStatus = "sent";
  } catch (e) {
    emailStatus = "failed";
    emailError = e instanceof Error ? e.message : String(e);
  }

  const patch: Record<string, unknown> = {
    email_status: emailStatus,
    email_error: emailError,
    email_sent_at: emailStatus === "sent" ? new Date().toISOString() : null,
  };
  if (!retryEmail) {
    patch.closed_at = new Date().toISOString();
    patch.closed_by = auth.ctx.email ?? null;
  }
  const { error: updErr } = await institutional.from("oems_order_book").update(patch).eq("sequence", sequence);
  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, sequence, closed: true, email_status: emailStatus, email_error: emailError });
}
