/**
 * GET /api/sa-rates/timeseries
 *
 * A7.7 — 3-year history of the headline SA macro series for the
 * `macro-timeseries` chart. Wraps the SARB public Web API time-series
 * endpoint, with a 1-hour revalidate window (SARB publishes ~daily).
 *
 * Codes:
 *   - `MMRD002A` SARB repo rate
 *   - `MMRD000A` SA prime rate
 *   - `MMRD855A` ZARONIA (overnight)
 *   - For "household-debt-to-GDP", SARB's public feed is behind the
 *     data portal (no free public key), so we render an honest
 *     `code-gap` row. The chart surfaces this with a dashed line + an
 *     explanatory empty state.
 *
 * Each series is keyed on its own `revalidate` window so an outage in
 * one code doesn't block the others. The route never throws — failures
 * are surfaced as `error` fields on the affected series, and the chart
 * skips them.
 */
import { unstable_cache } from "next/cache";

import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SarbTimeseriesPoint {
  Date?: string;
  Value?: number;
}

interface SarbTimeseriesResponse {
  data?: SarbTimeseriesPoint[];
  error?: { message?: string };
}

const SARB_TS_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/TimeSeries";

const SERIES: Array<{
  id: "repo" | "prime" | "zaronia" | "household_debt_to_gdp";
  label: string;
  code: string;
  unit: "%";
  source: "sarb" | "code-gap";
}> = [
  { id: "repo", label: "SARB Repo", code: "MMRD002A", unit: "%", source: "sarb" },
  { id: "prime", label: "Prime", code: "MMRD000A", unit: "%", source: "sarb" },
  { id: "zaronia", label: "ZARONIA", code: "MMRD855A", unit: "%", source: "sarb" },
  {
    id: "household_debt_to_gdp",
    label: "Household debt / GDP",
    code: "MMRD_HDGDP_A",
    unit: "%",
    source: "code-gap",
  },
];

async function fetchSeries(code: string, startDate: string, endDate: string): Promise<SarbTimeseriesPoint[]> {
  const url = `${SARB_TS_URL}?code=${encodeURIComponent(code)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&format=json`;
  const res = await fetch(url, {
    next: { revalidate: 3600 },
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`sarb-ts ${code} ${res.status}`);
  const body = (await res.json()) as SarbTimeseriesResponse;
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * A7.7 — fetch each headline series, normalise, and return a single
 * `series` object the chart can iterate over. The household-debt-to-GDP
 * series is a `code-gap` placeholder until a vendor (or the SARB data
 * portal API key) is wired in.
 */
const fetchTimeseries = unstable_cache(
  async () => {
    if (!isUseSupabaseQuotesEnabled()) {
      return {
        source: "unavailable",
        reason: "supabase_quotes_disabled",
        series: SERIES.map((s) => ({
          ...s,
          points: [],
          asOf: null,
          error: "supabase_quotes_disabled" as const,
        })),
      };
    }
    const end = new Date();
    const start = new Date(end.getTime() - 365 * 3 * 24 * 60 * 60 * 1000);
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const series = await Promise.all(
      SERIES.map(
        async (
          s,
        ): Promise<
          typeof s & { points: Array<{ date: string; value: number }>; asOf: string | null; error?: string }
        > => {
          if (s.source === "code-gap") {
            return { ...s, points: [], asOf: null, error: "code-gap" };
          }
          try {
            const raw = await fetchSeries(s.code, startDate, endDate);
            const points = raw
              .filter((p) => p.Date != null && p.Value != null && Number.isFinite(Number(p.Value)))
              .map((p) => ({ date: String(p.Date).slice(0, 10), value: Number(p.Value) }));
            const asOf = points.length > 0 ? points[points.length - 1]!.date : null;
            return { ...s, points, asOf };
          } catch (err) {
            return { ...s, points: [], asOf: null, error: err instanceof Error ? err.message : String(err) };
          }
        },
      ),
    );

    const anyData = series.some((s) => s.points.length > 0);
    return {
      source: anyData ? "sarb" : "unavailable",
      reason: anyData ? undefined : "sarb_unavailable",
      series,
    };
  },
  ["sa-rates-timeseries", isUseSupabaseQuotesEnabled() ? "supabase-on" : "supabase-off"],
  { revalidate: 3600, tags: ["sa-rates-timeseries"] },
);

export async function GET() {
  try {
    const body = await fetchTimeseries();
    return Response.json(body);
  } catch (err) {
    return Response.json(
      {
        source: "unavailable",
        reason: "fetch_failed",
        error: err instanceof Error ? err.message : String(err),
        series: SERIES.map((s) => ({ ...s, points: [], asOf: null, error: "fetch_failed" as const })),
      },
      { status: 200 },
    );
  }
}
