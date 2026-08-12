import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { requireMasterPassword } from "@/lib/admin/step-up";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/requests/[id]/release-to-orderbook
 *
 * A booked rebalance order (source="PAPER_MODEL_REBALANCE") stays on the
 * Rebalances tab, not the Active Orderbook, until an admin explicitly
 * releases it — nothing should "hit the order book" the moment a rebalance
 * is sent, only once a human has reviewed the actual order rows and decided
 * they're ready. Releasing flips each still-parked order's `source` to
 * `MINT_CLIENT_ORDER`, the same bucket a normal app order lives in — from
 * that point on it behaves exactly like any other app order (shows on
 * Active Orderbook, can be sent to market, can fill). `payload.book_id`,
 * `payload.rebalance_request_id` and everything else on the row are left
 * untouched, so the order's rebalance provenance is never lost.
 */

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!canResearchIc(auth.ctx, "rebalance", "approve_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // This is the final release from the protected Rebalances queue into the
  // Active Order Book. Re-authenticate the named master operator here, not
  // just in the UI, so a direct request cannot bypass the confirmation.
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const stepUp = await requireMasterPassword(body.admin_password);
  if (!stepUp.ok) {
    return NextResponse.json({ ok: false, error: stepUp.error }, { status: stepUp.status });
  }

  let db: ReturnType<typeof createInstitutionalServiceRoleClient> | null;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch {
    db = null;
  }
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const { data, error } = await db
    .from("oems_order_audit")
    .update({ source: "MINT_CLIENT_ORDER", updated_at: new Date().toISOString() })
    .eq("payload->>rebalance_request_id", id)
    .eq("source", "PAPER_MODEL_REBALANCE")
    .eq("status", "parked")
    .select("id");

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json(
        { ok: false, error: "oems_order_audit table not migrated yet." },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, released: (data ?? []).length });
}
