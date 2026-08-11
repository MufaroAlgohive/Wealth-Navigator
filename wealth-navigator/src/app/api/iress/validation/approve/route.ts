import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/iress/validation/approve
 *
 * Human-in-the-loop cutover gate: mark a symbol approved (or un-approved) to
 * prefer IRESS(PROD) over Yahoo. Approval is deliberately SEPARATE from the auto
 * `validated` verdict — a person decides, per symbol, when IRESS is trusted
 * enough to switch off Yahoo. The read/write overlay (Phase 2) consults this
 * flag; approving alone changes nothing until the overlay is wired.
 *
 * Body: { symbol: string, approved?: boolean }  (approved defaults true)
 * Gate: admin + rebalance/approve_rebalance (reuse the desk approver grant;
 * this is an operator decision affecting displayed prices).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!canResearchIc(auth.ctx, "rebalance", "approve_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase().replace(/\.(JO|JSE)$/i, "") : "";
  const approved = body.approved === undefined ? true : body.approved === true;
  if (!symbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });

  let db;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("iress_price_validation_c")
    .update({
      approved,
      approved_by: approved ? auth.ctx.email : null,
      approved_at: approved ? now : null,
      updated_at: now,
    })
    .eq("symbol", symbol)
    .select()
    .maybeSingle();

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json(
        { ok: false, error: "iress_price_validation_c not migrated yet — apply 20260716000001_iress_price_validation_c.sql." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: `No scoreboard row for ${symbol} yet — run a validation sample first.` },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, symbol, approved, row: data });
}
