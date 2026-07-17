import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { runPositionReconciliation } from "@/lib/recon/position-recon-server";

/**
 * GET /api/cron/position-reconciliation
 *
 * Runs one book-level position reconciliation: OUR positions (oems_position_c)
 * vs the external mirror (position_recon_external_c: iress_portfolio /
 * longmark_statement) and persists the per-symbol drift to
 * position_reconciliation_c. Read-only w.r.t. the money tables + oems_position_c.
 *
 * Until an external source is wired (the dormant worker IPSPositionGetAll1 loop
 * once Charles entitles it, or a Longmark statement import), the external table
 * is empty and every symbol records status='pending' — the audit trail runs
 * end-to-end and honestly reports "no external source yet".
 *
 * Auth: Vercel cron `Authorization: Bearer ${CRON_SECRET}`, OR an admin session.
 * Scheduled after the JSE close alongside the iress-validation cron.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret && bearer === secret) return true;
  const auth = await getAdminContext();
  return auth.status === "ok" && isAdminRole(auth.ctx);
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runPositionReconciliation();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
