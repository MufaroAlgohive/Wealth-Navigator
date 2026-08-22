import { type ProviderName, getProvider } from "@/lib/data/providers";
import { iressConfig } from "@/lib/iress";
import { type QuoteWithSource, fetchQuotesSafe } from "@/lib/iress/live-queries";
import { type SecurityPriceRow, resolveSecurityPrices } from "@/lib/market-prices/fallback";
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

  // IRESS → Yahoo fallback for any quote that came back with no usable price
  // (IRESS offline, IRESS test mode, sandbox seat, the symbol isn't covered,
  // etc.). Without this the cockpit reads `/api/quotes`, sees fallbackCount=0,
  // and reports "UNAVAILABLE" — even though Yahoo is happily serving live
  // prices for every symbol. Cents-safe via yahooPriceToCents: .JO instruments
  // are stored verbatim, non-JSE ×100. Reads only — never writes back.
  const STALE_PRICE_MS = (Number(process.env.IRESS_STALE_FALLBACK_HOURS) || 3) * 60 * 60 * 1000;
  const nowMs = Date.now();
  const missing = quotes
    .map((q, idx) => ({ q, idx }))
    .filter(({ q }) => {
      const hasPrice = Number.isFinite(q.quote.last) && Number(q.quote.last) > 0;
      const tsMs = typeof q.quote.ts === "number" ? q.quote.ts : new Date(q.quote.ts ?? 0).getTime();
      const tsFresh = Number.isFinite(tsMs) && nowMs - tsMs <= STALE_PRICE_MS;
      // Fall back when the price is missing OR the timestamp is stale.
      return !hasPrice || !tsFresh;
    });
  let yahooCount = 0;
  if (missing.length > 0) {
    try {
      const fallbackRows: SecurityPriceRow[] = missing.map(({ q }) => ({
        id: q.symbol,
        symbol: q.symbol,
        name: null,
        logo_url: null,
        last_price:
          Number.isFinite(q.quote.last) && Number(q.quote.last) > 0
            ? Math.round(Number(q.quote.last) * 100)
            : null,
        change_percent:
          Number.isFinite(q.quote.changePct) && q.quote.changePct != null ? Number(q.quote.changePct) : null,
        updated_at: typeof q.quote.ts === "number" ? new Date(q.quote.ts).toISOString() : null,
      }));
      const resolved = await resolveSecurityPrices({
        rows: fallbackRows,
        intradayBySecurityId: new Map(),
        maxYahoo: 60,
        concurrency: 4,
      });
      const bySymbol = new Map(resolved.map((r) => [r.symbol.toUpperCase(), r] as const));
      for (const { idx, q } of missing) {
        const r = bySymbol.get(q.symbol.toUpperCase());
        if (!r || r.price_rands == null || r.price_rands <= 0) continue;
        // Overwrite the IRESS/supabase row with the Yahoo-resolved price. Cents
        // math: price_rands (Rands) × 100 → integer cents to match the IRESS
        // convention used everywhere downstream.
        quotes[idx] = {
          ...q,
          quote: {
            ...q.quote,
            last: r.price_rands,
            // `q.quote.ts` is a number epoch ms — keep the Yahoo as-of timestamp
            // in the same shape. `price_as_of` is the ISO string from the truth
            // layer; coerce via Date.
            ts: r.price_as_of ? new Date(r.price_as_of).getTime() : Date.now(),
          },
          source: "yahoo",
        };
        yahooCount += 1;
      }
    } catch {
      /* Yahoo slow/down — fall through, the cockpit will report whatever the
       * raw source says (UNAVAILABLE / SUPABASE / SEED-FALLBACK). */
    }
  }

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

  // yahooCount counts the rows the live Yahoo fallback just filled in for
  // this call — the cockpit reads `fallbackCount` from this response and
  // uses it as the `yahooActive` signal in the centralised
  // resolveActiveDataSource() helper. Previously this was hardcoded to 0
  // here, which made the cockpit badge lie when IRESS was down.
  const fallbackCount = yahooCount + quotes.filter((q) => q.source === "seed-fallback").length;
  const dbCount = quotes.filter(
    (q) => q.source === "supabase" || q.source === "live" || q.source === "iress",
  ).length;

  return Response.json({
    mode: useSupabase ? "supabase" : iressConfig.mode,
    useSupabase,
    quotes: summaryQuotes,
    liveCount: quotes.filter((q) => q.source === "live" || q.source === "iress").length,
    fallbackCount,
    yahooCount: yahooCount,
    mockCount: quotes.filter((q) => q.source === "mock").length,
    supabaseCount: quotes.filter((q) => q.source === "supabase").length,
    unavailableCount: quotes.filter((q) => q.source === "unavailable").length,
    dbCount,
  });
}
