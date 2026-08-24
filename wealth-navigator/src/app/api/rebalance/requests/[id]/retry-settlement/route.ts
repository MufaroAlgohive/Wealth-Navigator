import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { maybeCompleteRebalance } from "@/lib/rebalance/complete-rebalance";
import { canRetryRebalanceSettlement } from "@/lib/rebalance/settlement-retry-policy";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Retry the post-fill settlement boundary for a fully-filled rebalance.
 *
 * Filling normally invokes this work automatically. This recovery endpoint is
 * It is useful when a deployment race or transient service failure leaves
 * fully-filled orders without their model flip or cash settlement. LIVE
 * recovery is Master-only; UAT keeps the normal IC-approver permission.
 * `maybeCompleteRebalance` is idempotent and refuses incomplete fills.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !canResearchIc(auth.ctx, "rebalance", "approve_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let institutional: ReturnType<typeof createInstitutionalServiceRoleClient> | null = null;
  let retail: ReturnType<typeof createRetailServiceRoleClient> | null = null;
  try {
    institutional = createInstitutionalServiceRoleClient();
    retail = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "required database connection is not configured" }, { status: 503 });
  }
  if (!institutional || !retail) {
    return NextResponse.json({ ok: false, error: "required database connection is not configured" }, { status: 503 });
  }

  const requestRes = await institutional
    .from("rebalance_request_c")
    .select("id, status, environment_scope")
    .eq("id", id)
    .maybeSingle();
  if (requestRes.error) return NextResponse.json({ ok: false, error: requestRes.error.message }, { status: 500 });
  if (!requestRes.data) return NextResponse.json({ ok: false, error: "rebalance request not found" }, { status: 404 });
  if (!canRetryRebalanceSettlement(requestRes.data.environment_scope, auth.ctx.approverTier)) {
    return NextResponse.json(
      { ok: false, error: "LIVE settlement recovery requires a Master account" },
      { status: 403 },
    );
  }
  if (!["executed", "completing"].includes(requestRes.data.status)) {
    return NextResponse.json({ ok: false, error: "rebalance is not ready to complete" }, { status: 409 });
  }

  const completion = await maybeCompleteRebalance(retail, institutional, id, auth.ctx.userId);
  if (!completion.completed) {
    return NextResponse.json({ ok: false, completion, error: completion.error ?? "rebalance is not ready for settlement" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, completion, cashSettlement: completion.cashSettlement });
}
