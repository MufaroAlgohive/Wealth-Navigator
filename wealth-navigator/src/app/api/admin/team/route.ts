import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { sendEmail, buildInviteHtml } from "@/lib/admin/email";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Mint admin team management. Ports the legacy `/api/team?action=...` family
 * over `admin_team` / `admin_team_audit` / `admin_approvals` (RETAIL DB).
 * Admin-only.
 *
 * DB-backed now: list, update (role/pages), update-permissions, remove,
 * audit-list, list-approvals, resolve-approval (status only).
 * DEFERRED (Resend email + Supabase auth-admin — backend bucket): the email
 * send for invite/resend and the auth-account email change + the auto-execute
 * side-effects after an approval. These return honest notices.
 */

export const dynamic = "force-dynamic";

async function guard() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return { db: null, ctx: null, error: NextResponse.json({ ok: false, error: "no-session" }, { status: 401 }) };
  if (auth.status !== "ok") return { db: null, ctx: null, error: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  if (!isAdminRole(auth.ctx)) return { db: null, ctx: null, error: NextResponse.json({ ok: false, error: "Admins only" }, { status: 403 }) };
  let db: SupabaseClient | null = null;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    db = null;
  }
  return { db, ctx: auth.ctx, error: null as null };
}

async function sendInvite(
  db: SupabaseClient,
  req: Request,
  email: string,
  role: string,
): Promise<{ emailSent: boolean; signupLink: string | null; emailReason: string | null }> {
  const origin = new URL(req.url).origin;
  const redirectTo = `${origin}/auth/callback?next=/signup`;
  let link: string | null = null;
  try {
    const { data, error } = await db.auth.admin.generateLink({ type: "invite", email, options: { redirectTo } });
    if (error) throw error;
    link = (data as { properties?: { action_link?: string } } | null)?.properties?.action_link ?? null;
  } catch (e) {
    return { emailSent: false, signupLink: null, emailReason: `Could not generate invite link: ${(e as Error).message}` };
  }
  if (!link) return { emailSent: false, signupLink: null, emailReason: "No invite link generated" };
  try {
    await sendEmail({ to: email, subject: "You're invited to the Mint Admin team", html: buildInviteHtml({ link, role }), emailType: "admin_invite", source: "team-invite" });
    return { emailSent: true, signupLink: link, emailReason: null };
  } catch (e) {
    return { emailSent: false, signupLink: link, emailReason: (e as Error).message };
  }
}

async function writeAudit(
  db: SupabaseClient,
  entry: { action: string; target_email?: string | null; target_member_id?: string | null; actor_email: string; details: Record<string, unknown> },
) {
  try {
    await db.from("admin_team_audit").insert(entry);
  } catch {
    /* audit table optional */
  }
}

export async function GET(req: Request) {
  const g = await guard();
  if (g.error) return g.error;
  const action = new URL(req.url).searchParams.get("action");
  const url = new URL(req.url);
  const { db } = g;

  if (action === "list") {
    if (!db) return NextResponse.json({ ok: true, members: [] });
    const { data, error } = await db
      .from("admin_team")
      .select("id, full_name, email, role, page_access, approver_tier, permissions, status, created_at")
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ ok: false, error: error.message });
    return NextResponse.json({ ok: true, members: data ?? [] });
  }

  if (action === "audit-list") {
    if (!db) return NextResponse.json({ ok: true, entries: [], notice: "RETAIL database not configured." });
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
    let q = db.from("admin_team_audit").select("*").order("created_at", { ascending: false }).limit(limit);
    const auditAction = url.searchParams.get("audit_action");
    const actor = url.searchParams.get("actor_email");
    const target = url.searchParams.get("target_email");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (auditAction) q = q.eq("action", auditAction);
    if (actor) q = q.ilike("actor_email", `%${actor}%`);
    if (target) q = q.ilike("target_email", `%${target}%`);
    if (from) q = q.gte("created_at", from);
    if (to) q = q.lte("created_at", to);
    const { data, error } = await q;
    if (error) return NextResponse.json({ ok: true, entries: [], notice: "Audit table not available." });
    return NextResponse.json({ ok: true, entries: data ?? [] });
  }

  if (action === "list-approvals") {
    if (!db) return NextResponse.json({ ok: true, approvals: [], notice: "RETAIL database not configured." });
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
    const status = url.searchParams.get("status") || "pending";
    const type = url.searchParams.get("type");
    let q = db.from("admin_approvals").select("*").order("created_at", { ascending: false }).limit(limit);
    if (status && status !== "all") q = q.eq("status", status);
    if (type) q = q.eq("type", type);
    const { data, error } = await q;
    if (error) return NextResponse.json({ ok: true, approvals: [], notice: "Approvals table not found." });
    return NextResponse.json({ ok: true, approvals: data ?? [] });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g.error) return g.error;
  const { db, ctx } = g;
  const action = new URL(req.url).searchParams.get("action");
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  if (action === "invite") {
    const email = String(body.email || "").trim().toLowerCase();
    const full_name = String(body.full_name || "").trim();
    const role = body.role === "admin" ? "admin" : "staff";
    const page_access = role === "staff" && Array.isArray(body.page_access) ? body.page_access : [];
    if (!email) return NextResponse.json({ ok: false, error: "Email is required" }, { status: 400 });
    if (!email.endsWith("@mymint.co.za")) {
      return NextResponse.json({ ok: false, error: "Only @mymint.co.za email addresses can be invited." }, { status: 400 });
    }
    if (!db) return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
    const { error } = await db
      .from("admin_team")
      .upsert({ email, full_name, role, page_access, status: "pending" }, { onConflict: "email" });
    if (error) return NextResponse.json({ ok: false, error: error.message });
    const invite = await sendInvite(db, req, email, role);
    await writeAudit(db, { action: "invite", target_email: email, actor_email: ctx!.email, details: { role, page_access, email_sent: invite.emailSent } });
    return NextResponse.json({ ok: true, ...invite });
  }

  if (action === "resend") {
    const id = String(body.id || "");
    if (!id || !db) return NextResponse.json({ ok: false, error: "Missing id or DB" }, { status: 400 });
    const { data: m } = await db.from("admin_team").select("email, role").eq("id", id).maybeSingle();
    if (!m?.email) return NextResponse.json({ ok: false, error: "Member not found" }, { status: 404 });
    const invite = await sendInvite(db, req, m.email as string, (m.role as string) || "staff");
    return NextResponse.json({ ok: true, ...invite });
  }

  if (action === "update-permissions") {
    const id = String(body.id || "");
    if (!id || !db) return NextResponse.json({ ok: false, error: "Missing id or DB" }, { status: 400 });
    const approver_tier = body.approver_tier == null ? null : String(body.approver_tier);
    const permissions = (body.permissions ?? {}) as Record<string, unknown>;
    const { data: before } = await db.from("admin_team").select("approver_tier, permissions").eq("id", id).maybeSingle();
    const { error } = await db.from("admin_team").update({ approver_tier, permissions }).eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message });
    await writeAudit(db, {
      action: "update",
      target_member_id: id,
      actor_email: ctx!.email,
      details: { before: before ?? {}, after: { approver_tier, permissions } },
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "update-email") {
    const id = String(body.id || "");
    const new_email = String(body.new_email || "").trim().toLowerCase();
    if (!id || !new_email) return NextResponse.json({ ok: false, error: "Missing id or email" }, { status: 400 });
    if (!new_email.endsWith("@mymint.co.za")) {
      return NextResponse.json({ ok: false, error: "Must be a @mymint.co.za address." }, { status: 400 });
    }
    if (!db) return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
    // Change the Supabase auth account email too, so they can sign in with it.
    let authUpdated = false;
    const { data: member } = await db.from("admin_team").select("user_id").eq("id", id).maybeSingle();
    if (member?.user_id) {
      try {
        const { error: authErr } = await db.auth.admin.updateUserById(member.user_id as string, { email: new_email });
        if (!authErr) authUpdated = true;
      } catch {
        /* auth-admin unavailable */
      }
    }
    const { error } = await db.from("admin_team").update({ email: new_email }).eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message });
    await writeAudit(db, { action: "update", target_member_id: id, actor_email: ctx!.email, details: { email_changed_to: new_email, auth_updated: authUpdated } });
    return NextResponse.json({ ok: true, authUpdated });
  }

  if (action === "resolve-approval") {
    const id = String(body.id || "");
    const decision = body.decision === "approved" ? "approved" : "rejected";
    const notes = body.notes == null ? null : String(body.notes);
    if (!id || !db) return NextResponse.json({ ok: false, error: "Missing id or DB" }, { status: 400 });
    const { data: approval, error } = await db
      .from("admin_approvals")
      .update({ status: decision, reviewed_by_email: ctx!.email, reviewed_at: new Date().toISOString(), notes })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message });
    // NOTE: auto-execute side-effects (send trade confirmation / commit fill
    // price) are deferred with the orderbook/email backend port.
    return NextResponse.json({ ok: true, approval });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}

export async function PATCH(req: Request) {
  const g = await guard();
  if (g.error) return g.error;
  const { db, ctx } = g;
  const action = new URL(req.url).searchParams.get("action");
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  if (action === "update") {
    const id = String(body.id || "");
    if (!id || !db) return NextResponse.json({ ok: false, error: "Missing id or DB" }, { status: 400 });
    const role = body.role === "admin" ? "admin" : "staff";
    const page_access = role === "staff" && Array.isArray(body.page_access) ? body.page_access : [];
    const { data: before } = await db.from("admin_team").select("role, approver_tier, page_access").eq("id", id).maybeSingle();
    const { error } = await db.from("admin_team").update({ role, page_access }).eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message });
    await writeAudit(db, {
      action: "update",
      target_member_id: id,
      actor_email: ctx!.email,
      details: { before: before ?? {}, after: { role, page_access } },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const g = await guard();
  if (g.error) return g.error;
  const { db, ctx } = g;
  const action = new URL(req.url).searchParams.get("action");
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  if (action === "remove") {
    const id = String(body.id || "");
    if (!id || !db) return NextResponse.json({ ok: false, error: "Missing id or DB" }, { status: 400 });
    const { data: before } = await db.from("admin_team").select("email, role").eq("id", id).maybeSingle();
    const { error } = await db.from("admin_team").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message });
    await writeAudit(db, {
      action: "remove",
      target_email: (before as { email?: string } | null)?.email ?? null,
      target_member_id: id,
      actor_email: ctx!.email,
      details: { role: (before as { role?: string } | null)?.role ?? null },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}
