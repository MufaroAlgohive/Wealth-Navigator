/**
 * BFF sector heatmap endpoint — DB-first.
 *
 * GET /api/sectors
 *
 * Returns the latest per-sector `change_pct` from `sector_intraday_c`
 * (populated by the worker TimeSeriesGet2 loop). The shape is the same
 * as the existing `sectorHeatmap` seed in `lib/iress/seed.ts` so the
 * Cockpit `<SectorHeatmap>` can render the response as-is:
 *
 *   [{ code, name, changePct, last }, ...]
 *
 * When the table is empty (entitlement not yet on) the response is
 * `{ sectors: [], source: "entitlement-required" }` so the UI can show
 * the precise "ask Charles" message.
 */

import { isSupabaseConfigured, createServiceRoleClient } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { sectorHeatmap } from "@/lib/iress/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SectorIntradayRow {
  sector_code: string;
  sector_name: string | null;
  value: number;
  change_pct: number;
  timestamp: string;
}

export async function GET() {
  const useSupabase = isUseSupabaseQuotesEnabled();

  if (useSupabase) {
    if (!isSupabaseConfigured()) {
      return Response.json(
        { error: "USE_SUPABASE_QUOTES=true but Supabase not configured", sectors: [], source: "unavailable" },
        { status: 500 },
      );
    }
    const supabase = createServiceRoleClient();

    // Get the most-recent timestamp for each sector_code. Postgres
    // `DISTINCT ON` is the cleanest way to do this; the supabase-js
    // client doesn't expose raw SQL so we fetch a windowed view: top 2
    // per sector, then dedupe in JS. Cheap because each sector has at
    // most a few recent ticks.
    const { data: rows, error } = await supabase
      .from("sector_intraday_c")
      .select("sector_code, sector_name, value, change_pct, timestamp")
      .order("timestamp", { ascending: false })
      .limit(200);
    if (error) {
      return Response.json(
        { error: error.message, sectors: [], source: "unavailable" },
        { status: 500 },
      );
    }
    const seen = new Set<string>();
    const latest: SectorIntradayRow[] = [];
    for (const r of (rows ?? []) as SectorIntradayRow[]) {
      if (seen.has(r.sector_code)) continue;
      seen.add(r.sector_code);
      latest.push(r);
    }
    if (latest.length === 0) {
      return Response.json({
        sectors: [],
        source: "entitlement-required",
        message:
          "Sector index intraday requires TimeSeriesGet2 entitlement for the J200 / sector codes. " +
          "Ask Charles to enable on the production account.",
        hint: "Set IRESS_WORKER_INSTRUMENT_SYNC=1 and IRESS_TIMESERIES_SECTOR_CODES=J200,J201 on the worker once enabled.",
      });
    }
    return Response.json({
      sectors: latest.map((r) => ({
        sector: r.sector_name ?? r.sector_code,
        weight: 0,
        change: Number(r.change_pct),
        code: r.sector_code,
        name: r.sector_name ?? r.sector_code,
        changePct: Number(r.change_pct),
        last: Number(r.value),
        asOf: r.timestamp,
      })),
      source: "supabase",
    });
  }

  // Mock / non-supabase path: serve the seed heatmap.
  return Response.json({
    sectors: sectorHeatmap,
    source: "seed-fallback",
  });
}
