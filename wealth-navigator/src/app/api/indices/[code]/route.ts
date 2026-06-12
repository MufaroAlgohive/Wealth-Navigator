/**
 * BFF index intraday endpoint — DB-first.
 *
 * GET /api/indices/[code]?window=1d|5d
 *
 * Returns the most-recent intraday points for the given index code
 * (e.g. "J203" for the JSE All Share, "J200" for JSE Resources, ...).
 * The route is a thin DB reader over `index_intraday_c` (populated by the
 * worker `TimeSeriesGet2` loop). When the table is empty (entitlement
 * not yet on) the response is `{ points: [], source: "entitlement-required" }`
 * so the UI can show the precise "ask Charles" message.
 *
 * The shape is the same as the existing `intraday` array in
 * `cockpit-client.tsx` (`{ t, v }` points) so the recharts
 * `<AreaChart>` can render it as-is.
 */

import { isSupabaseConfigured, createServiceRoleClient } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { globalIndices } from "@/lib/iress/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IndexIntradayRow {
  index_code: string;
  value: number;
  timestamp: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params;
  const code = rawCode.toUpperCase();
  if (!code) {
    return Response.json({ error: "code path param required" }, { status: 400 });
  }
  const url = new URL(req.url);
  const windowKey = (url.searchParams.get("window") ?? "1d").toLowerCase();
  const limit = windowKey === "5d" ? 2000 : 1000;

  const useSupabase = isUseSupabaseQuotesEnabled();

  if (useSupabase) {
    if (!isSupabaseConfigured()) {
      return Response.json(
        { error: "USE_SUPABASE_QUOTES=true but Supabase not configured", code, points: [] },
        { status: 500 },
      );
    }
    const supabase = createServiceRoleClient();
    const { data: rows, error } = await supabase
      .from("index_intraday_c")
      .select("value, timestamp")
      .eq("index_code", code)
      .order("timestamp", { ascending: true })
      .limit(limit);
    if (error) {
      return Response.json(
        { error: error.message, code, points: [], source: "unavailable" },
        { status: 500 },
      );
    }
    const points = ((rows ?? []) as IndexIntradayRow[]).map((r) => ({
      t: new Date(r.timestamp).getTime(),
      v: Number(r.value),
    }));
    if (points.length === 0) {
      return Response.json({
        code,
        points: [],
        source: "entitlement-required",
        message:
          "ALSI / index intraday requires TimeSeriesGet2 entitlement. " +
          "Ask Charles to enable on the production account.",
        hint: "Set IRESS_TIMESERIES_INDEX_CODES=J203 on the worker once enabled.",
      });
    }
    return Response.json({ code, points, source: "supabase" });
  }

  // Mock / non-supabase path: synthesise a deterministic 78-point
  // intraday series off the seed index level so the chart still
  // renders during local dev.
  const seed = globalIndices.find((i) => i.code === code);
  const base = seed?.last ?? 87000;
  const now = Date.now();
  const points = Array.from({ length: 78 }, (_, i) => ({
    t: now - (78 - i) * 60_000,
    v: +(base * (1 + (Math.sin(i / 4) * 0.0025) + (i / 78) * 0.0048)).toFixed(2),
  }));
  return Response.json({ code, points, source: "seed-fallback" });
}
