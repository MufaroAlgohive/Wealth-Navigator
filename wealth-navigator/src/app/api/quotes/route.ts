import { iressConfig } from "@/lib/iress";
import { fetchQuotesSafe, type QuoteWithSource } from "@/lib/iress/live-queries";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF quote endpoint — DB-first when `USE_SUPABASE_QUOTES=true`, otherwise
 * proxies to `live-queries` (IRESS SOAP, then seed fallback).
 *
 * GET /api/quotes?symbols=NPN,PRX,...&exchange=JSE
 *
 * Response shape:
 *   {
 *     mode: "supabase" | "live" | "mock" | "wsdl-stub",
 *     useSupabase: boolean,
 *     quotes: Array<{ symbol, last_price, ts, source }>,
 *     liveCount, fallbackCount, mockCount, supabaseCount
 *   }
 *
 * Source taxonomy (matches DataSourceBadge / QuoteSource in live-queries):
 *   "supabase"      — read from stock_intraday_c (worker is the source of truth)
 *   "live"          — IRESS SOAP PricingQuoteGet succeeded
 *   "seed-fallback" — live path failed; UI shows SEED badge
 *   "mock"          — IRESS_MODE=mock, no live path attempted
 */
function isUseSupabaseQuotesEnabled(): boolean {
  const raw = process.env.USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols") ?? "NPN";
  const exchange = url.searchParams.get("exchange") ?? "JSE";
  const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return Response.json({ error: "symbols query param required" }, { status: 400 });
  }

  const useSupabase = isUseSupabaseQuotesEnabled();

  if (useSupabase && !isSupabaseConfigured()) {
    return Response.json(
      {
        error: "USE_SUPABASE_QUOTES=true but Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
        useSupabase: true,
      },
      { status: 500 },
    );
  }

  const quotes: QuoteWithSource[] = await fetchQuotesSafe(symbols, exchange);

  const summaryQuotes = quotes.map((q) => ({
    symbol: q.symbol,
    last_price: q.quote.last,
    prev_close: q.quote.prevClose,
    bid: q.quote.bid,
    ask: q.quote.ask,
    change: q.quote.change,
    change_pct: q.quote.changePct,
    ts: q.quote.ts,
    source: q.source,
  }));

  return Response.json({
    mode: useSupabase ? "supabase" : iressConfig.mode,
    useSupabase,
    quotes: summaryQuotes,
    liveCount: quotes.filter((q) => q.source === "live").length,
    fallbackCount: quotes.filter((q) => q.source === "seed-fallback").length,
    mockCount: quotes.filter((q) => q.source === "mock").length,
    supabaseCount: quotes.filter((q) => q.source === "supabase").length,
    unavailableCount: quotes.filter((q) => q.source === "unavailable").length,
  });
}
