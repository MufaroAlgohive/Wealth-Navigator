import { type ProviderName, getProvider } from "@/lib/data/providers";
import { iressConfig } from "@/lib/iress";
import { type QuoteWithSource, fetchQuotesSafe } from "@/lib/iress/live-queries";
import { isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: ReadonlySet<ProviderName> = new Set(["iress", "yahoo", "mock", "iris"]);

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
  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return Response.json({ error: "symbols query param required" }, { status: 400 });
  }

  // Provider-override path: when the caller names a specific provider, run
  // the request through `getProvider(name).fetchQuotes(...)` and surface the
  // provider-shaped rows directly. This skips the DB-first path so the
  // parity scan (`scripts/scan-provider-parity.ts`) gets a fair IRESS-vs-Yahoo
  // comparison instead of IRESS-via-DB vs Yahoo-via-DB.
  const requestedProvider = url.searchParams.get("provider")?.toLowerCase() as ProviderName | null;
  if (requestedProvider) {
    if (!VALID_PROVIDERS.has(requestedProvider)) {
      return Response.json(
        {
          ok: false,
          error: `unknown provider "${requestedProvider}"; expected one of: ${[...VALID_PROVIDERS].join(", ")}`,
        },
        { status: 400 },
      );
    }
    const provider = getProvider(requestedProvider);
    const rows = await provider.fetchQuotes(symbols);
    return Response.json({
      ok: true,
      mode: provider.name,
      useSupabase: false,
      provider: provider.name,
      providerOverride: requestedProvider,
      quotes: rows.map((r) => ({
        symbol: r.symbol,
        last_price: r.last,
        prev_close: r.prevClose,
        bid: r.bid,
        ask: r.ask,
        change: null,
        change_pct: null,
        ts: r.timestamp,
        source: r.source,
        ...(r.error ? { error: r.error } : {}),
      })),
      liveCount: rows.filter((r) => r.source === "iress").length,
      fallbackCount: 0,
      mockCount: rows.filter((r) => r.source === "mock").length,
      supabaseCount: rows.filter((r) => r.source === "supabase").length,
      yahooCount: rows.filter((r) => r.source === "yahoo").length,
      unavailableCount: rows.filter((r) => r.last == null).length,
    });
  }

  const useSupabase = isUseSupabaseQuotesEnabled();

  if (useSupabase && !isRetailSupabaseConfigured()) {
    return Response.json(
      {
        error:
          "USE_SUPABASE_QUOTES=true but retail Supabase not configured (RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY, or legacy SUPABASE_*)",
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
    // "iress" (IRESS-PROD overlay applied) counts as a LIVE row so
    // deriveDataSource classifies the feed live/hybrid, not mock — the row
    // carries its precise "iress" source for per-symbol badging.
    liveCount: quotes.filter((q) => q.source === "live" || q.source === "iress").length,
    fallbackCount: quotes.filter((q) => q.source === "seed-fallback").length,
    mockCount: quotes.filter((q) => q.source === "mock").length,
    supabaseCount: quotes.filter((q) => q.source === "supabase").length,
    unavailableCount: quotes.filter((q) => q.source === "unavailable").length,
  });
}
