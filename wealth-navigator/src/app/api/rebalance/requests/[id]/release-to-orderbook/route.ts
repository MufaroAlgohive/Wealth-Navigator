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

  let db: ReturnType<typeof createInstitutionalServiceRoleClient> | null;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch {
    db = null;
  }
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  // UAT is a separately governed rehearsal environment. Its authorised IC
  // approvers may progress an already-executed UAT rebalance without a Master
  // password. LIVE remains step-up protected at the server boundary.
  const requestRes = await db
    .from("rebalance_request_c")
    .select("environment_scope, status")
    .eq("id", id)
    .maybeSingle();
  if (requestRes.error) return NextResponse.json({ ok: false, error: requestRes.error.message }, { status: 500 });
  if (!requestRes.data) return NextResponse.json({ ok: false, error: "rebalance request not found" }, { status: 404 });
  if (requestRes.data.status !== "executed") {
    return NextResponse.json({ ok: false, error: "rebalance must be on the Rebalance tab before release" }, { status: 409 });
  }

  const isUat = String(requestRes.data.environment_scope ?? "live").toLowerCase() === "uat";
  if (!isUat) {
    const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const stepUp = await requireMasterPassword(body.admin_password);
    if (!stepUp.ok) {
      return NextResponse.json({ ok: false, error: stepUp.error }, { status: stepUp.status });
    }
  }

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
