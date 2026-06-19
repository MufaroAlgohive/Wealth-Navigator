import { NextResponse } from "next/server";

import { createSupabaseServerClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Activate an invited admin after they set their password. Ports the legacy
 * `/api/team?action=complete-signup`: flips the `admin_team` row to active.
 */
export async function POST(req: Request) {
  let auth;
  try {
    auth = await createSupabaseServerClient();
  } catch {
    return NextResponse.json({ ok: false, error: "auth-unconfigured" }, { status: 503 });
  }
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.email) return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { full_name?: string };
  const full_name = String(body.full_name || "").trim();

  try {
    const db = createRetailServiceRoleClient();
    const patch: Record<string, unknown> = { status: "active" };
    if (full_name) patch.full_name = full_name;
    await db.from("admin_team").update(patch).ilike("email", user.email);
  } catch {
    /* admin_team may be unconfigured in dev */
  }
  return NextResponse.json({ ok: true });
}
