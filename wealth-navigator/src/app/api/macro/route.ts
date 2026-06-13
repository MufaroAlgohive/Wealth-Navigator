/**
 * GET /api/macro
 *
 * DB-first read of `macro_indicator_c` (time series) and
 * `macro_release_c` (calendar). Both are empty in v1 — the macro
 * page renders the honest "Vendor contract required" empty state.
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IndicatorRow {
  indicator_id: string;
  name: string;
  country: string;
  unit: string | null;
  value: number | string;
  prior_value: number | string | null;
  as_of: string;
  source: string | null;
}

interface ReleaseRow {
  release_id: string;
  indicator_id: string;
  name: string;
  release_at: string;
  country: string;
  source: string;
  consensus: number | string | null;
  prior: number | string | null;
  importance: string | null;
  tags: string[] | null;
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapIndicator(r: IndicatorRow) {
  const value = n(r.value);
  const prior = n(r.prior_value);
  const trend: "up" | "down" | "flat" = value > prior ? "up" : value < prior ? "down" : "flat";
  return {
    id: r.indicator_id,
    name: r.name,
    country: r.country,
    value: value,
    unit: r.unit ?? "",
    prior,
    trend,
    asOf: r.as_of,
    source: r.source ?? "iress-worker",
  };
}

function mapRelease(r: ReleaseRow) {
  return {
    id: r.release_id,
    indicatorId: r.indicator_id,
    name: r.name,
    ts: new Date(r.release_at).getTime(),
    country: r.country,
    source: r.source,
    consensus: n(r.consensus),
    prior: n(r.prior),
    importance: r.importance ?? "low",
    tags: r.tags ?? [],
  };
}

export async function GET() {
  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json({
      indicators: [],
      releases: [],
      source: "unavailable",
      reason: "supabase_quotes_disabled",
    });
  }
  if (!isSupabaseConfigured()) {
    return Response.json(
      { indicators: [], releases: [], source: "unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }
  const supabase = createServiceRoleClient();
  const [indRes, relRes] = await Promise.all([
    supabase
      .from("macro_indicator_c")
      .select("*")
      .order("as_of", { ascending: false })
      .limit(200),
    supabase
      .from("macro_release_c")
      .select("*")
      .order("release_at", { ascending: true })
      .limit(50),
  ]);
  if (indRes.error || relRes.error) {
    const firstErr = indRes.error ?? relRes.error;
    return Response.json(
      {
        indicators: [],
        releases: [],
        source: "unavailable",
        reason: "supabase_query_failed" as BffUnavailableReason,
        error: firstErr?.message,
        migration: isSupabaseSchemaMissing(firstErr)
          ? "supabase/migrations/20260613000006_macro_universe.sql"
          : undefined,
      },
      { status: 200 },
    );
  }
  const indicators = ((indRes.data ?? []) as IndicatorRow[]).map(mapIndicator);
  const releases = ((relRes.data ?? []) as ReleaseRow[]).map(mapRelease);
  return Response.json({
    indicators,
    releases,
    source: indicators.length > 0 || releases.length > 0 ? "supabase" : "unavailable",
    reason: indicators.length === 0 && releases.length === 0 ? "empty" : undefined,
    message:
      indicators.length === 0 && releases.length === 0
        ? "Macro indicators + release calendar require a vendor contract (SARB / StatsSA / Reuters). v1 returns an empty list with the honest 'vendor not configured' empty state."
        : undefined,
  });
}
