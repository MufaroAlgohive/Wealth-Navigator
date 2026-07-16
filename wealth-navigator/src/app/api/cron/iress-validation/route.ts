import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { runValidationSample } from "@/lib/iress/validation-server";

/**
 * GET /api/cron/iress-validation
 *
 * Runs one IRESS(PROD)-vs-Yahoo comparison sample and persists it to the
 * accuracy scoreboard (iress_price_validation_c). Scheduled over market hours
 * during the dual-seat window so each symbol builds a stability track record
 * before any Yahoo->IRESS cutover. Read-only w.r.t. the money tables.
 *
 * Auth: Vercel cron `Authorization: Bearer ${CRON_SECRET}`, OR an admin session.
 * No-op-safe: if the prod market-data seat is off, IRESS returns CT/test values
 * and divergence stays high — the scoreboard just records that (nothing cuts
 * over automatically).
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
  const result = await runValidationSample();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
