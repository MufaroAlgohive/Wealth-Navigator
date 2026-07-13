import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/models/[id]        (id = model slug, e.g. 'qentari_bravo_jse')
 *
 * Full detail bundle for one quant model: registry row, all metric snapshots,
 * equity curve (backtest + live), latest predictions, latest position snapshot,
 * recent trades and the recent run/heartbeat log. All from the INSTITUTIONAL
 * model_*_c tables. Read-only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: slug } = await ctx.params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = createInstitutionalServiceRoleClient();

  const { data: model, error: modelErr } = await db
    .from("model_registry_c")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (modelErr) {
    return NextResponse.json({
      ok: false,
      error: "model_registry_c not found. Apply migration 20260712000001_model_tracking_c.sql.",
    }, { status: 200 });
  }
  if (!model) {
    return NextResponse.json({ ok: false, error: `No model '${slug}'` }, { status: 404 });
  }

  // Fetch the child data in parallel.
  const [metricsR, equityR, predsR, posR, tradesR, runsR] = await Promise.all([
    db.from("model_metric_c").select("*").eq("model_slug", slug).order("as_of", { ascending: false }),
    db.from("model_equity_point_c").select("*").eq("model_slug", slug).order("ts", { ascending: true }).limit(4000),
    db.from("model_prediction_c").select("*").eq("model_slug", slug).order("predicted_at", { ascending: false }).limit(200),
    db.from("model_position_c").select("*").eq("model_slug", slug).order("snapshot_at", { ascending: false }).limit(200),
    db.from("model_trade_c").select("*").eq("model_slug", slug).order("exit_at", { ascending: false, nullsFirst: false }).limit(300),
    db.from("model_run_c").select("*").eq("model_slug", slug).order("created_at", { ascending: false }).limit(30),
  ]);

  const metrics = metricsR.data ?? [];
  const equity = equityR.data ?? [];
  const predictions = predsR.data ?? [];
  const positionsAll = posR.data ?? [];
  const trades = tradesR.data ?? [];
  const runs = runsR.data ?? [];

  // Latest position snapshot only (most recent snapshot_at).
  const latestSnap = positionsAll.length ? positionsAll[0].snapshot_at : null;
  const positions = latestSnap ? positionsAll.filter((p) => p.snapshot_at === latestSnap) : [];

  // Latest prediction batch (most recent predicted_at).
  const latestPredAt = predictions.length ? predictions[0].predicted_at : null;
  const latestPredictions = latestPredAt
    ? predictions.filter((p) => p.predicted_at === latestPredAt)
    : [];

  const now = Date.now();
  const hb = model.last_heartbeat_at ? new Date(model.last_heartbeat_at).getTime() : 0;

  return NextResponse.json({
    ok: true,
    model: {
      ...model,
      heartbeatFresh: hb > 0 && now - hb < 36 * 60 * 60 * 1000,
      heartbeatAgeMs: hb > 0 ? now - hb : null,
    },
    metrics,
    equity,
    predictions,
    latestPredictions,
    latestPredictedAt: latestPredAt,
    positions,
    positionSnapshotAt: latestSnap,
    trades,
    runs,
  });
}
