import { fetchQuotesSafe } from "@/lib/iress/live-queries";
import { iressConfig } from "@/lib/iress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Batch live quotes — server-side only, protected by mint-auth middleware.
 *
 * GET /api/iress/quotes?symbols=NPN,PRX&exchange=JSE
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols") ?? "NPN";
  const exchange = url.searchParams.get("exchange") ?? "JSE";
  const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return Response.json({ error: "symbols query param required" }, { status: 400 });
  }

  if (iressConfig.mode === "mock") {
    const { fetchQuotes } = await import("@/lib/iress/live-queries");
    const quotes = await fetchQuotes(symbols, exchange);
    return Response.json({
      mode: "mock",
      quotes,
      liveCount: 0,
      fallbackCount: 0,
      mockCount: quotes.length,
    });
  }

  const quotes = await fetchQuotesSafe(symbols, exchange);
  const liveCount = quotes.filter((q) => q.source === "live").length;
  const fallbackCount = quotes.filter((q) => q.source === "seed-fallback").length;

  return Response.json({
    mode: iressConfig.mode,
    quotes,
    liveCount,
    fallbackCount,
    mockCount: quotes.filter((q) => q.source === "mock").length,
  });
}
