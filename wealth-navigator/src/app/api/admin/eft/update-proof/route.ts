import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * PATCH /api/admin/eft/update-proof
 *
 * Phase B4 — alternate write path for `wallet_transactions.proof_url`.
 *
 * Mostly used when an admin already uploaded the image straight to the
 * `wealth-navigator-proofs` bucket via the browser client (skipping the
 * BFF node). The page calls this endpoint to persist the resulting signed
 * URL on the row.
 *
 * Body:
 *   { transaction_id: uuid, proof_url: string }
 *
 * Returns `{ ok, transaction }` on success.
 */

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (auth.ctx.approverTier !== "dev" && !can(auth.ctx, "eft", "approve_eft")) {
    return NextResponse.json({ ok: false, error: "Missing eft/approve_eft" }, { status: 403 });
  }

  let db: ReturnType<typeof createRetailServiceRoleClient> | null = null;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as {
    transaction_id?: string;
    proof_url?: string;
  };
  const transactionId = String(body.transaction_id || "");
  const proofUrl = String(body.proof_url || "");
  if (!transactionId)
    return NextResponse.json({ ok: false, error: "transaction_id required" }, { status: 400 });
  if (!proofUrl) return NextResponse.json({ ok: false, error: "proof_url required" }, { status: 400 });

  const { data: updated, error } = await db
    .from("wallet_transactions")
    .update({ proof_url: proofUrl })
    .eq("id", transactionId)
    .select("id, proof_url")
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ ok: false, error: "Transaction not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    transaction: { id: updated.id, proof_url: updated.proof_url },
  });
}
