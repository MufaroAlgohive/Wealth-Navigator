export interface YahooTruthQuote {
  symbol: string;
  yahooSymbol: string;
  priceCents: number;
  currency: string;
  exchangeTime: string;
  fetchedAt: string;
  source: "Yahoo Finance chart API";
}

export function yahooPriceToCents(yahooSymbol: string, rawPrice: number): number {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    throw new Error(`Yahoo returned no positive price for ${yahooSymbol}`);
  }
  return /\.JO$/i.test(yahooSymbol) ? Math.round(rawPrice) : Math.round(rawPrice * 100);
}

export async function fetchYahooTruthQuote(symbol: string): Promise<YahooTruthQuote> {
  const clean = symbol
    .trim()
    .toUpperCase()
    .replace(/\.JSE$/i, ".JO");
  const yahooSymbol = clean.includes(".") || clean.includes("=") ? clean : `${clean}.JO`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m`,
      {
        cache: "no-store",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 MINT-Source-of-Truth/1.0" },
      },
    );
    if (!response.ok) throw new Error(`Yahoo ${response.status} for ${yahooSymbol}`);
    const payload = (await response.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            currency?: string;
            regularMarketTime?: number;
          };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
        error?: { description?: string } | null;
      };
    };
    const result = payload.chart?.result?.[0];
    if (!result) throw new Error(payload.chart?.error?.description || `No Yahoo data for ${yahooSymbol}`);
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const lastClose = [...closes].reverse().find((value) => value != null && Number(value) > 0);
    const rawPrice = Number(result.meta?.regularMarketPrice ?? lastClose);
    // Yahoo JSE instruments are quoted in ZAc; RETAIL stores all prices in cents.
    // Non-JSE instruments are major currency units and are converted to cents.
    const priceCents = yahooPriceToCents(yahooSymbol, rawPrice);
    const marketTime =
      result.meta?.regularMarketTime ??
      [...(result.timestamp ?? [])].reverse().find((value) => Number(value) > 0);
    return {
      symbol,
      yahooSymbol,
      priceCents,
      currency: result.meta?.currency ?? "ZAR",
      exchangeTime: marketTime ? new Date(marketTime * 1000).toISOString() : new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      source: "Yahoo Finance chart API",
    };
  } finally {
    clearTimeout(timer);
  }
}
