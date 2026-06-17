/**
 * GET /api/history/[sym]?range=1M
 *
 * Daily price history for the Security page chart ranges (5D / 1M / 6M / YTD /
 * 1Y / 5Y / All) — proxied from the worker's /history endpoint (IRESS
 * TimeSeriesGet2). 1D stays on the intraday tick path (/api/intraday); this
 * serves the longer windows.
 *
 * Values are the IRESS daily close in the series' native scale (the chart
 * auto-fits min/max, so the trend shape is correct without a labelled y-axis).
 */
import { callWorker } from "@/lib/iress/worker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE_DAYS: Record<string, number> = {
  "5D": 8,
  "1M": 33,
  "6M": 190,
  "1Y": 370,
  "5Y": 1830,
  ALL: 3700,
};

function daysForRange(range: string): number {
  if (range === "YTD") {
    const now = new Date();
    const jan1 = Date.UTC(now.getUTCFullYear(), 0, 1);
    return Math.max(8, Math.ceil((now.getTime() - jan1) / 86_400_000));
  }
  return RANGE_DAYS[range] ?? 370;
}

export async function GET(req: Request, { params }: { params: Promise<{ sym: string }> }) {
  const { sym: rawSym } = await params;
  const code = rawSym.replace(/\.(JO|JSE)$/i, "").toUpperCase();
  if (!code) return Response.json({ error: "sym path param required" }, { status: 400 });

  const url = new URL(req.url);
  const range = (url.searchParams.get("range") ?? "1Y").toUpperCase();
  const exchange = url.searchParams.get("exchange") ?? "JSE";
  const days = daysForRange(range);

  const res = await callWorker<{ ok: boolean; sym: string; points?: Array<{ t: number; v: number }>; error?: string }>({
    path: `/history?sym=${encodeURIComponent(code)}&days=${days}&exchange=${encodeURIComponent(exchange)}`,
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    return Response.json({ sym: code, range, points: [], source: "unavailable", error: res.error });
  }

  const raw = Array.isArray(res.body?.points) ? res.body!.points! : [];
  const points = raw
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t);

  return Response.json({
    sym: code,
    range,
    points,
    count: points.length,
    source: points.length > 0 ? "iress" : "unavailable",
    sourceLabel: "IRESS TimeSeriesGet2 (daily)",
  });
}
