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

  // Derived rollup for the Demo Account KPIs: prefer a stored `live`/`paper`
  // metric row (so externally-computed fields like sharpe/cagr/win_rate still
  // win), but fall back to computing final_equity / total_return / max_drawdown
  // / start_date from the equity curve when the pusher hasn't written a metric
  // row (the lumibot dashboard sometimes only persists one equity point).
  const storedLive = metrics.find((m) => m.kind === "live" || m.kind === "paper");
  const paperCurve = equity.filter(
    (p) => (p.kind === "paper" || p.kind === "live") && typeof p.equity === "number",
  );
  let derivedLive: typeof storedLive = null;
  if (!storedLive && paperCurve.length >= 1) {
    const sorted = [...paperCurve].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
    );
    const startEq = Number(sorted[0]!.equity);
    const endEq = Number(sorted[sorted.length - 1]!.equity);
    let peak = startEq;
    let maxDd = 0;
    for (const p of sorted) {
      const v = Number(p.equity);
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = v / peak - 1;
        if (dd < maxDd) maxDd = dd;
      }
    }
    derivedLive = {
      model_slug: slug,
      kind: "paper",
      label: "derived",
      as_of: sorted[sorted.length - 1]!.ts,
      start_date: String(sorted[0]!.ts).slice(0, 10),
      end_date: String(sorted[sorted.length - 1]!.ts).slice(0, 10),
      budget: model.budget ?? startEq,
      final_equity: endEq,
      total_return: startEq > 0 ? endEq / startEq - 1 : null,
      max_drawdown: maxDd,
    };
  }
  const effectiveLive = storedLive ?? derivedLive;

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
    derivedLive,
    effectiveLive,
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
