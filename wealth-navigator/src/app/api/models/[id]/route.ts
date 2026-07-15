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

  // Derived rollup for the Demo Account KPIs.
  //
  // The paper equity curve is the SINGLE SOURCE OF TRUTH for the model account:
  //   start_capital = first equity point
  //   current_value = latest equity point
  //   total_return  = (current - start) / start
  //   max_drawdown  = peak-to-trough on the curve
  //
  // The pusher's `model_metric_c.budget / final_equity / total_return /
  // max_drawdown` columns are *display echoes* — they can lag the curve, drift
  // if the pusher is configured against a stale registry budget, or simply be
  // wrong (the lumibot pusher writes `registry.budget` into the metric, so a
  // R500k registry budget leaks into the metric row even when the curve
  // started at R100k).
  //
  // Stored metric rows STILL win for fields the curve can't supply
  // (sharpe / cagr / win_rate / volatility / sortino / romad / fees_bps /
  // benchmark_cagr / alpha_cagr / n_trades / n_round_trips / avg_pnl_per_trade
  // / extra). We take a base metric row, override the four curve-truthy fields
  // above, and return that as `effectiveLive`.
  const storedLive = metrics.find((m) => m.kind === "live" || m.kind === "paper");
  const paperCurve = equity.filter(
    (p) => (p.kind === "paper" || p.kind === "live") && typeof p.equity === "number",
  );

  // Sort the paper curve ascending by timestamp (PostgREST already returns
  // them sorted, but defensive in case the column has microsecond jitter on
  // repeated intraday inserts).
  const sortedPaper = [...paperCurve].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );

  let curveStartEq: number | null = null;
  let curveEndEq: number | null = null;
  let curveMaxDd: number | null = null;
  let curveStartDate: string | null = null;
  if (sortedPaper.length >= 1) {
    curveStartEq = Number(sortedPaper[0]!.equity);
    curveEndEq = Number(sortedPaper[sortedPaper.length - 1]!.equity);
    curveStartDate = String(sortedPaper[0]!.ts).slice(0, 10);
    let peak = curveStartEq;
    let dd = 0;
    for (const p of sortedPaper) {
      const v = Number(p.equity);
      if (v > peak) peak = v;
      if (peak > 0) {
        const x = v / peak - 1;
        if (x < dd) dd = x;
      }
    }
    curveMaxDd = dd;
  }

  // Build the live rollup the UI reads: take the stored metric row when one
  // exists (carries sharpe/cagr/etc), and overwrite the curve-truthy fields
  // with the freshly computed values from the equity curve.
  const effectiveLive = (() => {
    const base = storedLive ?? (sortedPaper.length >= 1 ? {
      model_slug: slug,
      kind: "paper",
      label: "derived",
      as_of: sortedPaper[sortedPaper.length - 1]!.ts,
    } : null);
    if (base == null) return null;
    return {
      ...base,
      // The curve wins, always. fall back to the stored value only when the
      // curve has no equity points at all (which means the pusher hasn't
      // started yet and the stored metric is the best signal we have).
      budget: curveStartEq ?? base.budget ?? null,
      final_equity: curveEndEq ?? base.final_equity ?? null,
      total_return: curveStartEq != null && curveStartEq > 0 && curveEndEq != null
        ? curveEndEq / curveStartEq - 1
        : base.total_return ?? null,
      max_drawdown: curveMaxDd ?? base.max_drawdown ?? null,
      start_date: curveStartDate ?? base.start_date ?? null,
      end_date: sortedPaper.length
        ? String(sortedPaper[sortedPaper.length - 1]!.ts).slice(0, 10)
        : base.end_date ?? null,
    };
  })();

  // `derivedLive` is kept as an alias for back-compat with the type — the
  // effective row IS the derived+overlaid record now.
  const derivedLive = effectiveLive;

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
