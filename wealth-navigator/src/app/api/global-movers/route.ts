/**
 * GET /api/global-movers?market=US
 *
 * Biggest movers + a market-cap heatmap for non-JSE exchanges, sourced from
 * Yahoo Finance's predefined screeners (most_actives / day_gainers /
 * day_losers). JSE is served separately from securities_c (/api/equities);
 * this covers the "switch to NYSE/Nasdaq" overview.
 *
 * Yahoo's quote/screener endpoints now require a cookie + crumb. We fetch one
 * once and cache it (30 min); screener results are cached briefly (30s) so a
 * busy desk doesn't hammer Yahoo. Everything degrades to an honest
 * `source:"unavailable"` empty payload if Yahoo blocks the call — no synthetic
 * data is ever returned.
 *
 * Source is unofficial (Yahoo public endpoints), best-effort — labelled as such
 * in the UI. Only US is wired today (predefined screeners are US-centric);
 * other regions need custom POST screeners.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const YF_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

type Cc = { crumb: string; cookie: string; at: number };
let crumbCache: Cc | null = null;
const CRUMB_TTL = 30 * 60 * 1000;

async function getCrumb(): Promise<Cc | null> {
  if (crumbCache && Date.now() - crumbCache.at < CRUMB_TTL) return crumbCache;
  // Step 1 — obtain a session cookie. fc.yahoo.com 404s but still sets it.
  let cookie = "";
  for (const u of ["https://fc.yahoo.com", "https://finance.yahoo.com"]) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": YF_UA }, redirect: "manual", cache: "no-store" });
      const sc = r.headers.get("set-cookie");
      if (sc) {
        cookie = sc.split(";")[0] ?? "";
        if (cookie) break;
      }
    } catch {
      /* try next */
    }
  }
  if (!cookie) return null;
  // Step 2 — exchange the cookie for a crumb.
  try {
    const r = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YF_UA, Cookie: cookie },
      cache: "no-store",
    });
    const crumb = (await r.text()).trim();
    if (!crumb || crumb.includes("<") || crumb.length > 32) return null;
    crumbCache = { crumb, cookie, at: Date.now() };
    return crumbCache;
  } catch {
    return null;
  }
}

interface YfQuote {
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  marketCap?: number;
  fullExchangeName?: string;
}

async function screener(scrId: string, count: number, cc: Cc): Promise<YfQuote[]> {
  const url =
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved` +
    `?count=${count}&scrIds=${scrId}&crumb=${encodeURIComponent(cc.crumb)}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": YF_UA, Cookie: cc.cookie }, cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as { finance?: { result?: Array<{ quotes?: YfQuote[] }> } };
    return j?.finance?.result?.[0]?.quotes ?? [];
  } catch {
    return [];
  }
}

type Mover = { symbol: string; name: string; chg: number; price: number | null };
type Tile = { symbol: string; name: string; chg: number; cap: number };
type Payload = {
  market: string;
  source: "yahoo" | "unavailable";
  sourceLabel: string;
  tiles: Tile[];
  gainers: Mover[];
  losers: Mover[];
  error?: string;
};

const resultCache = new Map<string, { at: number; payload: Payload }>();
const RESULT_TTL = 30 * 1000;

const toMover = (q: YfQuote): Mover => ({
  symbol: q.symbol ?? "?",
  name: q.shortName ?? q.longName ?? q.symbol ?? "?",
  chg: q.regularMarketChangePercent ?? 0,
  price: q.regularMarketPrice ?? null,
});

export async function GET(req: Request) {
  const market = (new URL(req.url).searchParams.get("market") ?? "US").toUpperCase();

  // Only US is wired (predefined screeners are US-centric).
  if (market !== "US") {
    return Response.json({
      market,
      source: "unavailable",
      sourceLabel: "Yahoo Finance",
      tiles: [],
      gainers: [],
      losers: [],
      error: "market-not-wired",
    } satisfies Payload);
  }

  const cached = resultCache.get(market);
  if (cached && Date.now() - cached.at < RESULT_TTL) return Response.json(cached.payload);

  const cc = await getCrumb();
  if (!cc) {
    return Response.json({
      market,
      source: "unavailable",
      sourceLabel: "Yahoo Finance",
      tiles: [],
      gainers: [],
      losers: [],
      error: "yahoo-auth-failed",
    } satisfies Payload);
  }

  const [actives, gainers, losers] = await Promise.all([
    screener("most_actives", 50, cc),
    screener("day_gainers", 25, cc),
    screener("day_losers", 25, cc),
  ]);

  // Heatmap: biggest names by market cap from the most-active set (dedup).
  const seen = new Set<string>();
  const tiles: Tile[] = actives
    .filter((q) => q.symbol && (q.marketCap ?? 0) > 0)
    .filter((q) => (seen.has(q.symbol!) ? false : (seen.add(q.symbol!), true)))
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    .slice(0, 36)
    .map((q) => ({
      symbol: q.symbol!,
      name: q.shortName ?? q.longName ?? q.symbol!,
      chg: q.regularMarketChangePercent ?? 0,
      cap: q.marketCap ?? 0,
    }));

  if (tiles.length === 0 && gainers.length === 0 && losers.length === 0) {
    return Response.json({
      market,
      source: "unavailable",
      sourceLabel: "Yahoo Finance",
      tiles: [],
      gainers: [],
      losers: [],
      error: "no-data",
    } satisfies Payload);
  }

  const payload: Payload = {
    market,
    source: "yahoo",
    sourceLabel: "Yahoo Finance (unofficial)",
    tiles,
    gainers: gainers.slice(0, 8).map(toMover),
    losers: losers.slice(0, 8).map(toMover),
  };
  resultCache.set(market, { at: Date.now(), payload });
  return Response.json(payload);
}
