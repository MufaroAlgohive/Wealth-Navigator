import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/action-items/dismiss
 *
 * Dismiss an item from the action-items bar. Dismissing hides the item from
 * the current user's banner view, but keeps it in the underlying queue so
 * it can still be resolved from the source page (e.g. `/oems/banking/eft`).
 *
 * Body: `{ id: string, type: string }`
 *   - `id`: the source-table row id (admin_approvals.id, wallet_transactions.id, etc.)
 *   - `type`: the item type discriminator ("admin_approval" | "eft_pending" | ...)
 *
 * Stores the dismissal in `admin_dismissed_notifications` (RETAIL DB). If
 * the migration hasn't been pasted yet the route returns 200 with
 * `dismissed: false` — the bar still re-renders on next poll and the user
 * sees the same item, which is the honest fallback.
 *
 * Audit: every successful dismiss writes a row to `admin_team_audit` with
 * action='approval_action' so the Audit Log tab on `/admin/team` shows it.
 *
 * Gate: signed-in admin team member.
 */

export const dynamic = "force-dynamic";

const VALID_TYPES = new Set(["admin_approval", "eft_pending", "rebalance_ready", "manual_funds", "mm_topup"]);

async function writeAudit(
  db: ReturnType<typeof createRetailServiceRoleClient>,
  entry: {
    actor_email: string;
    action: string;
    target_email?: string | null;
    details: Record<string, unknown>;
  },
) {
  try {
    await db.from("admin_team_audit").insert(entry);
  } catch {
    /* audit table optional */
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

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";

  if (!id || !type) {
    return NextResponse.json({ ok: false, error: "id and type are required" }, { status: 400 });
  }
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ ok: false, error: `unknown type: ${type}` }, { status: 400 });
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

  const dismissedAt = new Date().toISOString();
  const { error } = await db
    .from("admin_dismissed_notifications")
    .upsert(
      { user_email: auth.ctx.email, item_id: id, item_type: type, dismissed_at: dismissedAt },
      { onConflict: "user_email,item_id,item_type" },
    );

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      // Migration not pasted yet — be honest about the no-op.
      return NextResponse.json({
        ok: true,
        dismissed: false,
        notice: "admin_dismissed_notifications table not found — dismiss not persisted.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await writeAudit(db, {
    actor_email: auth.ctx.email,
    action: "approval_action",
    details: {
      action: "dismiss",
      item_id: id,
      item_type: type,
      dismissed_at: dismissedAt,
    },
  });

  return NextResponse.json({ ok: true, dismissed: true });
}
