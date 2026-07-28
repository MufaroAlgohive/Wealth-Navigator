/**
 * POST /api/admin/orderbook/delete-cancelled
 *
 * PERMANENTLY deletes a cancelled order's audit row from `oems_order_audit`.
 * Unlike cancel (which flips status to 'cancelled' and keeps the row), this
 * removes it — used to clear the Cancelled tab of test/wrong orders the desk
 * no longer wants on record.
 *
 * Guardrails (this is a hard delete on a broker/audit table, so it's fenced):
 *  - admin session + `orderbook.send_to_market` RBAC (same as cancel), AND
 *  - the caller must re-enter their own password (verified via a throwaway
 *    anon sign-in, the same confirm pattern admin/strategies uses for
 *    destructive catalogue actions), AND
 *  - the row must already be status='cancelled'. A working/filled/partial/
 *    rejected order can NEVER be deleted through here — a live or filled
 *    broker order must stay on record. Fails 409 otherwise.
 *
 * Body: { order_audit_id: string, password: string }
 * Returns: { ok, deleted?, error? }
 */

import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { createAnonServerClient, createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const auditId = typeof body.order_audit_id === "string" ? body.order_audit_id.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!auditId) {
    return NextResponse.json({ ok: false, error: "order_audit_id is required" }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ ok: false, error: "Password is required" }, { status: 400 });
  }

  // Re-verify the admin's own password before a destructive delete.
  const verifier = createAnonServerClient();
  const { error: pwErr } = await verifier.auth.signInWithPassword({ email: auth.ctx.email, password });
  if (pwErr) {
    return NextResponse.json({ ok: false, error: "Incorrect password" }, { status: 403 });
  }

  let db;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Supabase not configured" },
      { status: 503 },
    );
  }

  // Only a cancelled row may be deleted — re-read status under the service role
  // and fail closed if it isn't (or was concurrently released).
  const { data: row, error: readErr } = await db
    .from("oems_order_audit")
    .select("id, status")
    .eq("id", auditId)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: `No order found for id=${auditId}` }, { status: 404 });
  }
  if (row.status !== "cancelled") {
    return NextResponse.json(
      {
        ok: false,
        error: `Refused: only cancelled orders can be deleted (current status: ${row.status}).`,
      },
      { status: 409 },
    );
  }

  // Delete is scoped by BOTH id and status='cancelled' so a status change that
  // raced in between the read and here can never let a non-cancelled row through.
  const { error: delErr } = await db
    .from("oems_order_audit")
    .delete()
    .eq("id", auditId)
    .eq("status", "cancelled");
  if (delErr) {
    return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: auditId });
}
