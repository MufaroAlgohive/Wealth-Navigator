import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/notifications
 *
 * Returns the full list of dismissed action-items for the signed-in admin.
 * The bar uses this to filter out items the user has hidden (the action-items
 * BFF already does this on the server, but exposing it lets the marketing hub
 * and audit surfaces show "n hidden" hints if they want to).
 *
 * Gate: signed-in admin team member.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let db: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    db = createRetailServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `database not configured: ${(e as Error).message}` },
      { status: 503 },
    );
  }

  const { data, error } = await db
    .from("admin_dismissed_notifications")
    .select("item_id, item_type, dismissed_at")
    .eq("user_email", auth.ctx.email)
    .order("dismissed_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({
        ok: true,
        items: [],
        notice: "admin_dismissed_notifications table not found.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    items: data ?? [],
    count: (data ?? []).length,
  });
}
