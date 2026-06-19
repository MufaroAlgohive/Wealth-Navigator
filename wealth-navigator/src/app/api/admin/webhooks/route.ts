import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Email webhook-trigger CRUD. Ports the legacy `/api/webhooks` (GET/POST/
 * PATCH/DELETE) over `email_webhook_triggers` (RETAIL DB). Any team member.
 * NOTE: the webhook *receiver* (`POST /api/webhooks/supabase`) + actual email
 * sending is a backend port deferred with the rest of the data/email plumbing.
 */

export const dynamic = "force-dynamic";

async function requireMember() {
  const auth = await getAdminContext();
  if (auth.status === "ok") return { ok: true as const };
  if (auth.status === "no-session") return { ok: false as const, status: 401 };
  return { ok: false as const, status: 403 };
}

export async function GET() {
  const m = await requireMember();
  if (!m.ok) return NextResponse.json({ error: "unauthorized" }, { status: m.status });

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ error: "RETAIL database not configured" });
  }
  const { data, error } = await db
    .from("email_webhook_triggers")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message });
  return NextResponse.json(data ?? []);
}

export async function POST(req: Request) {
  const m = await requireMember();
  if (!m.ok) return NextResponse.json({ error: "unauthorized" }, { status: m.status });

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  delete body.id;
  delete body.created_at;
  delete body.updated_at;

  const db = createRetailServiceRoleClient();
  const { data, error } = await db.from("email_webhook_triggers").insert(body).select().maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: Request) {
  const m = await requireMember();
  if (!m.ok) return NextResponse.json({ error: "unauthorized" }, { status: m.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  delete body.id;
  delete body.created_at;

  const db = createRetailServiceRoleClient();
  const { data, error } = await db
    .from("email_webhook_triggers")
    .update(body)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: Request) {
  const m = await requireMember();
  if (!m.ok) return NextResponse.json({ error: "unauthorized" }, { status: m.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const db = createRetailServiceRoleClient();
  const { error } = await db.from("email_webhook_triggers").delete().eq("id", id);
  return NextResponse.json({ ok: !error });
}
