import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { validationBucket, validationMinStreak, type ValidationRow } from "@/lib/iress/validation";
import { runValidationSample } from "@/lib/iress/validation-server";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * /api/iress/validation
 *
 * GET  — read the per-symbol IRESS(PROD)-vs-Yahoo accuracy scoreboard
 *        (iress_price_validation_c), bucketed for an operator view.
 * POST — run ONE comparison sample now and persist it (admin trigger; the cron
 *        does this on a schedule over the dual-seat window).
 *
 * Read-only w.r.t. the money tables. Admin-gated.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIGRATION_HINT =
  "iress_price_validation_c not migrated yet — apply 20260716000001_iress_price_validation_c.sql.";

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let db;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, rows: [], notice: "INSTITUTIONAL database not configured." });
  }

  const { data, error } = await db
    .from("iress_price_validation_c")
    .select("*")
    .order("consecutive_ok", { ascending: false });
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({ ok: true, rows: [], notice: MIGRATION_HINT });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as ValidationRow[];
  const withBucket = rows.map((r) => ({ ...r, bucket: validationBucket(r) }));
  const counts = { approved: 0, validated: 0, watch: 0, breach: 0, "no-data": 0 } as Record<string, number>;
  for (const r of withBucket) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;

  return NextResponse.json({
    ok: true,
    minStreak: validationMinStreak(),
    counts,
    rows: withBucket,
    note: "AUTO 'validated' = IRESS covered + within tolerance for a stable streak. Cutover still requires manual 'approved'.",
  });
}

export async function POST() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const result = await runValidationSample();
  if (!result.ok && result.error && /not migrated/i.test(result.error)) {
    return NextResponse.json({ ...result, notice: MIGRATION_HINT }, { status: 409 });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
