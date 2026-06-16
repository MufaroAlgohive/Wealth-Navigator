/**
 * BFF yield-curve history endpoint — DB-first.
 *
 * GET /api/curves/[code]
 *
 * Returns the most-recent fitted curve for the given IRESS code
 * (e.g. "ZAR_NSS", "ZAR_GOVI", "R2030", …). When `USE_SUPABASE_QUOTES=true`
 * the route reads `yield_curve_history_c` (populated by the worker
 * TimeSeriesGet2 loop); otherwise it falls back to the seed curve and
 * tags the response with `source: "seed-fallback"`.
 *
 * The response shape is deliberately close to what the Cockpit
 * `ZAR Sovereign Curve` panel already expects: an array of
 * `{ tenor, yield }` points so the existing recharts `<LineChart>` can
 * render the curve as-is.
 *
 * Tier 2 wiring: until Charles enables `TimeSeriesGet2` on the production
 * account, the worker loop logs `time_series_entitlement_missing` and the
 * table stays empty. The route returns `{ points: [], source: "entitlement-required" }`
 * so the UI can show the precise "ask Charles" message instead of a
 * generic "Data feed not configured".
 */

import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { zarGoviCurve } from "@/lib/iress/seed";
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface YieldCurveRow {
  curve_id: string;
  tenor_label: string;
  tenor_years: number;
  yield_pct: number;
  as_of: string;
}

function seedPoints(): { tenor: string; years: number; yield: number; asOf: string }[] {
  const asOf = new Date().toISOString();
  return zarGoviCurve.map((p) => ({
    tenor: p.tenor,
    years: p.tenorMonths / 12,
    yield: p.yield,
    asOf,
  }));
}

function asOfSeedCurve(code: string): { tenor: string; years: number; yield: number; asOf: string }[] {
  if (code === "ZAR_NSS" || code === "ZAR_GOVI") {
    return seedPoints();
  }
  return [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await params;
  const code = rawCode.toUpperCase();
  if (!code) {
    return Response.json({ error: "code path param required" }, { status: 400 });
  }

  const useSupabase = isUseSupabaseQuotesEnabled();

  if (useSupabase) {
    if (!isSupabaseConfigured()) {
      return Response.json(
        { error: "USE_SUPABASE_QUOTES=true but Supabase not configured", code, points: [], source: "unavailable", reason: "supabase_not_configured" as BffUnavailableReason },
        { status: 503 },
      );
    }
    const supabase = createServiceRoleClient();

    // Fitted curves (ZAR_NSS nominal, ZAR_GOVI, ZAR_REAL inflation-linked) are
    // multi-tenor — read all tenors at the latest as_of in a single query. Bond
    // codes (R2030, R2035, ...) return a single point per row.
    const FITTED_CURVES = new Set(["ZAR_NSS", "ZAR_GOVI", "ZAR_REAL"]);
    if (FITTED_CURVES.has(code)) {
      // Get the latest as_of for this curve_id.
      const { data: latestRows, error: latestErr } = await supabase
        .from("yield_curve_history_c")
        .select("as_of")
        .eq("curve_id", code)
        .order("as_of", { ascending: false })
        .limit(1);
      if (latestErr) {
        return Response.json(
          {
            error: latestErr.message,
            code,
            points: [],
            source: "unavailable",
            reason: "supabase_query_failed" as BffUnavailableReason,
            migration: isSupabaseSchemaMissing(latestErr)
              ? "supabase/migrations/20260612000007_yield_curve_history_c.sql"
              : undefined,
          },
          { status: 200 },
        );
      }
      const latest = (latestRows ?? [])[0] as { as_of: string } | undefined;
      if (!latest) {
        return Response.json({
          code,
          points: [],
          source: useSupabase ? "pending-first-write" : "seed-fallback",
          reason: "empty" as BffUnavailableReason,
          message:
            `No ${code} curve snapshot in the table yet. The worker builds this curve from ` +
            "the YFX/YFXD bond basket (TimeSeriesGet2 confirmed working) on its time-series " +
            "loop — wait one poll interval after the worker (re)starts for the first snapshot.",
          hint: "If this persists, check the worker's IRESS_TIMESERIES_CURVE_CODES / IRESS_TIMESERIES_REAL_CODES and that the time-series loop is running.",
        });
      }
      const { data: rows, error: rowsErr } = await supabase
        .from("yield_curve_history_c")
        .select("tenor_label, tenor_years, yield_pct, as_of")
        .eq("curve_id", code)
        .eq("as_of", latest.as_of)
        .order("tenor_years", { ascending: true });
      if (rowsErr) {
        return Response.json(
          {
            error: rowsErr.message,
            code,
            points: [],
            source: "unavailable",
            reason: "supabase_query_failed" as BffUnavailableReason,
            migration: isSupabaseSchemaMissing(rowsErr)
              ? "supabase/migrations/20260612000007_yield_curve_history_c.sql"
              : undefined,
          },
          { status: 200 },
        );
      }
      const points = ((rows ?? []) as YieldCurveRow[]).map((r) => ({
        tenor: r.tenor_label,
        years: Number(r.tenor_years),
        yield: Number(r.yield_pct),
        asOf: r.as_of,
      }));
      return Response.json({
        code,
        points,
        asOf: latest.as_of,
        source: points.length > 0 ? "supabase" : "entitlement-required",
        reason: points.length === 0 ? ("entitlement_blocked" as BffUnavailableReason) : undefined,
      });
    }

    // Single-bond code path.
    const { data: rows, error: bondErr } = await supabase
      .from("yield_curve_history_c")
      .select("tenor_label, tenor_years, yield_pct, as_of")
      .eq("curve_id", code)
      .order("as_of", { ascending: false })
      .limit(1);
    if (bondErr) {
      return Response.json(
        {
          error: bondErr.message,
          code,
          points: [],
          source: "unavailable",
          reason: "supabase_query_failed" as BffUnavailableReason,
          migration: isSupabaseSchemaMissing(bondErr)
            ? "supabase/migrations/20260612000007_yield_curve_history_c.sql"
            : undefined,
        },
        { status: 200 },
      );
    }
    const points = ((rows ?? []) as YieldCurveRow[]).map((r) => ({
      tenor: r.tenor_label,
      years: Number(r.tenor_years),
      yield: Number(r.yield_pct),
      asOf: r.as_of,
    }));
    if (points.length === 0) {
      return Response.json({
        code,
        points: [],
        source: "entitlement-required",
        reason: "entitlement_blocked" as BffUnavailableReason,
        message:
          "TimeSeriesGet2 entitlement required for bond series. " +
          "Ask Charles to enable TimeSeriesGet2 for the R-bond codes on the production account.",
        hint: "Set IRESS_TIMESERIES_CURVE_CODES=R2030,R2035,R2040 on the worker once enabled.",
      });
    }
    return Response.json({ code, points, source: "supabase" });
  }

  // Mock / live-without-supabase path: serve the seed curve.
  const points = asOfSeedCurve(code);
  return Response.json({
    code,
    points,
    source: points.length > 0 ? "seed-fallback" : "unavailable",
    reason: points.length === 0 ? "empty" : undefined,
  });
}
