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

import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { globalIndices } from "@/lib/iress/seed";
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IndexIntradayRow {
  index_code: string;
  value: number;
  timestamp: string;
}

/**
 * JSE index codes that Yahoo can serve as a fallback while the IRESS index feed
 * is unavailable (UAT: index DataSource not yet confirmed). Yahoo prefixes JSE
 * indices with "^". Only codes Yahoo reliably prices are mapped.
 */
const YAHOO_INDEX: Record<string, string> = {
  J203: "^J203.JO", // JSE All Share
};

/** Yahoo intraday chart for an index symbol → `{ t, v }` points (or [] on any
 *  failure, so the caller can fall through to the honest empty state). */
async function fetchYahooIndexIntraday(
  yahooSym: string,
  windowKey: string,
): Promise<Array<{ t: number; v: number }>> {
  const range = windowKey === "5d" ? "5d" : "1d";
  const interval = windowKey === "5d" ? "30m" : "5m";
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const res = j.chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const closes = res?.indicators?.quote?.[0]?.close ?? [];
    const out: Array<{ t: number; v: number }> = [];
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i];
      const c = closes[i];
      if (t != null && c != null && Number.isFinite(c)) out.push({ t: t * 1000, v: c });
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
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
      // IRESS index feed is empty (UAT: DataSource not yet confirmed). Fall back
      // to Yahoo for the codes it covers (e.g. J203 → ^J203.JO) so the panel
      // shows the real index instead of an empty state. When IRESS index data
      // lands in prod, index_intraday_c is non-empty and this never runs.
      const ySym = YAHOO_INDEX[code];
      if (ySym) {
        const yPoints = await fetchYahooIndexIntraday(ySym, windowKey);
        if (yPoints.length >= 2) {
          return Response.json({ code, points: yPoints, source: "yahoo" });
        }
      }
      return Response.json({
        code,
        points: [],
        source: "entitlement-required",
        message:
          "No index time-series on the prod-test (CT) feed. TimeSeriesGet2 itself works " +
          "(confirmed live for equities) — J203 is accepted but returns no data on our " +
          "DataSource (JSED); the JSE index feed isn't enabled for DFM@MINT on CT. " +
          "Needs the index DataSource enabled by IRESS, or production.",
        hint: "Worker calls TimeSeriesGet2(J203) OK but gets 0 rows on CT (J203 quote shows ErrorNumber=1, no data). Awaiting the index DataSource from IRESS/Andre.",
      });
    }
    return Response.json({ code, points, source: "supabase" });
  }

  // Mock / non-supabase path. Prefer a real Yahoo series for codes it covers
  // (J203 -> ^J203.JO) so a split-flag config (server USE_SUPABASE_QUOTES off,
  // client expecting real data) shows the real index rather than a fabricated
  // level. Only fall through to the synthetic seed for unmapped codes / when
  // Yahoo is unreachable, so local dev still renders.
  const yMockSym = YAHOO_INDEX[code];
  if (yMockSym) {
    const yPoints = await fetchYahooIndexIntraday(yMockSym, windowKey);
    if (yPoints.length >= 2) {
      return Response.json({ code, points: yPoints, source: "yahoo" });
    }
  }
  const seed = globalIndices.find((i) => i.code === code);
  const base = seed?.last ?? 87000;
  const now = Date.now();
  const points = Array.from({ length: 78 }, (_, i) => ({
    t: now - (78 - i) * 60_000,
    v: +(base * (1 + Math.sin(i / 4) * 0.0025 + (i / 78) * 0.0048)).toFixed(2),
  }));
  return Response.json({ code, points, source: "seed-fallback" });
}
