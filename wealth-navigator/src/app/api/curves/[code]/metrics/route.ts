/**
 * GET /api/curves/[code]/metrics
 *
 * Reads the per-curve derived metrics (OIS-spread, carry, rolldown, PCA
 * factors) from `oems_curve_metric_c`. The table is populated by the
 * Railway `iress-ingest` worker when a fitted curve snapshot is
 * available; until then the response is `{ metrics: [], source:
 * "unavailable" }` so the UI renders the honest empty state.
 *
 * Response shape:
 *   {
 *     code: "ZAR_NSS" | ...,
 *     metrics: Array<{
 *       metric: "ois_spread_3m" | "carry_3m" | "pca_level" | ...,
 *       tenorLabel: string | null,
 *       value: number,
 *       unit: "bp" | "%",
 *       asOf: string
 *     }>,
 *     pca: { level, slope, curvature, residual } | null,
 *     source: "supabase" | "unavailable",
 *     message?: string
 *   }
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MetricRow {
  curve_id: string;
  metric: string;
  tenor_label: string | null;
  value: number | string;
  as_of: string;
  source: string | null;
}

/**
 * Map our `metric` column to a display unit. Carry / rolldown /
 * spread are in percent; PCA factors are in basis points.
 */
function unitForMetric(metric: string): "bp" | "%" {
  return metric.startsWith("pca_") ? "bp" : "%";
}

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await params;
  const code = (rawCode ?? "").toUpperCase();
  if (!code) {
    return Response.json({ error: "code path param required" }, { status: 400 });
  }

  if (!isUseSupabaseQuotesEnabled()) {
    // The curve metrics table is a Supabase-only artefact. In mock
    // mode the page falls back to its own deterministic seed; we
    // never want to confuse the two paths.
    return Response.json(
      {
        code,
        metrics: [],
        pca: null,
        source: "unavailable",
        reason: "supabase_quotes_disabled",
      },
      { status: 200 },
    );
  }

  if (!isSupabaseConfigured()) {
    return Response.json(
      {
        code,
        metrics: [],
        pca: null,
        source: "unavailable",
        reason: "supabase_not_configured",
      },
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();
  // Fetch the most-recent as_of for this curve_id, then read every
  // metric on that date. Cheaper than a window function for v1.
  const { data: latestRows, error: latestErr } = await supabase
    .from("oems_curve_metric_c")
    .select("as_of")
    .eq("curve_id", code)
    .order("as_of", { ascending: false })
    .limit(1);
  if (latestErr) {
    return Response.json(
      { code, metrics: [], pca: null, source: "unavailable", error: latestErr.message },
      { status: 500 },
    );
  }
  const latest = (latestRows ?? [])[0] as { as_of: string } | undefined;
  if (!latest) {
    return Response.json({
      code,
      metrics: [],
      pca: null,
      source: "unavailable",
      message:
        "The fitted ZAR_NSS curve is live (the bond yields flow from IRESS on YFX/YFXD). PCA / carry / rolldown aren't computed yet: PCA needs several days of daily curve snapshots to decompose, and the worker only began writing them today — this populates as history accumulates. (Carry/rolldown are single-curve and can be added sooner via a curve-metrics step.)",
      hint: "No action needed for the curve itself; the metrics fill in once a few days of yield_curve_history_c snapshots exist (or wire a curve-metrics computation step on the worker).",
    });
  }

  const { data: rows, error: rowsErr } = await supabase
    .from("oems_curve_metric_c")
    .select("metric, tenor_label, value, as_of, source")
    .eq("curve_id", code)
    .eq("as_of", latest.as_of);
  if (rowsErr) {
    return Response.json(
      { code, metrics: [], pca: null, source: "unavailable", error: rowsErr.message },
      { status: 500 },
    );
  }

  const metrics = (rows ?? []).map((r) => {
    const row = r as MetricRow;
    const value = typeof row.value === "number" ? row.value : Number(row.value);
    return {
      metric: row.metric,
      tenorLabel: row.tenor_label,
      value: Number.isFinite(value) ? value : 0,
      unit: unitForMetric(row.metric),
      asOf: row.as_of,
    };
  });

  // Convenience projection for the cockpit PCA panel: a single
  // {level, slope, curvature, residual} object. Each factor's
  // tenor_label is null (PCA is curve-wide, not per-tenor).
  const pcaFromRows = (factor: string) =>
    metrics.find((m) => m.metric === `pca_${factor}`)?.value ?? null;
  const pca = {
    level: pcaFromRows("level"),
    slope: pcaFromRows("slope"),
    curvature: pcaFromRows("curvature"),
    residual: pcaFromRows("residual"),
  };
  const pcaObject =
    pca.level == null && pca.slope == null && pca.curvature == null && pca.residual == null
      ? null
      : pca;

  return Response.json({
    code,
    metrics,
    pca: pcaObject,
    asOf: latest.as_of,
    source: metrics.length > 0 ? "supabase" : "unavailable",
  });
}
