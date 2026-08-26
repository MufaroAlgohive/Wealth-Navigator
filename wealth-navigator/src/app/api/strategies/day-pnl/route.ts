import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";
import { calculateAssetDayPnlCents, planQuoteRefresh, resolveDayPnlStrategyId } from "@/lib/pnl/asset-day-pnl";
import {
  createInstitutionalServiceRoleClient,
  createRetailServiceRoleClient,
  isRetailSupabaseConfigured,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import { fetchYahooTruthQuote, type YahooTruthQuote } from "@/lib/truth/yahoo-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_YAHOO_QUOTES_PER_REFRESH = 8;
const quoteCache = new Map<string, { refreshedAt: number; quote: YahooTruthQuote }>();
const sastDate = (value = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
}).format(value);
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const DIRECT_BOOK = "__DIRECT__";
const keyOf = (userId: string, familyId: string | null, strategyId: string | null, securityId: string) =>
  `${userId}|${familyId ?? ""}|${strategyId ?? DIRECT_BOOK}|${securityId}`;

async function loadQuotes(
  symbols: string[],
  persisted: Map<string, { refreshedAt: number; quote: YahooTruthQuote }>,
): Promise<{ quotes: Map<string, YahooTruthQuote>; refreshed: YahooTruthQuote[] }> {
  const output = new Map<string, YahooTruthQuote>();
  const refreshed: YahooTruthQuote[] = [];
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  for (const [symbol, row] of persisted) {
    const memory = quoteCache.get(symbol);
    if (!memory || memory.refreshedAt < row.refreshedAt) quoteCache.set(symbol, row);
  }
  for (const symbol of normalized) {
    const cached = quoteCache.get(symbol);
    if (cached) output.set(symbol, cached.quote);
  }

  // At most eight requests per 30-second UI refresh, two at a time. Missing
  // names are warmed first; afterwards the oldest cached names rotate. The
  // previous implementation repeatedly refreshed the first eight names and
  // could therefore leave every later name uncovered forever.
  const refreshedAt = new Map([...quoteCache].map(([symbol, row]) => [symbol, row.refreshedAt]));
  const refresh = planQuoteRefresh(normalized, refreshedAt, MAX_YAHOO_QUOTES_PER_REFRESH);
  for (let start = 0; start < refresh.length; start += 2) {
    const chunk = refresh.slice(start, start + 2);
    const settled = await Promise.allSettled(chunk.map((symbol) => fetchYahooTruthQuote(symbol)));
    settled.forEach((result, index) => {
      const symbol = chunk[index]!;
      if (result.status === "fulfilled") {
        quoteCache.set(symbol, { quote: result.value, refreshedAt: Date.now() });
        output.set(symbol, result.value);
        refreshed.push(result.value);
      }
    });
  }
  return { quotes: output, refreshed };
}

async function loadHistory(db: ReturnType<typeof createRetailServiceRoleClient>, from: string, to: string) {
  const rows: Array<Record<string, unknown>> = [];
  for (let start = 0; start < 50_000; start += 1000) {
    const result = await db.from("client_strategy_returns_effective_c")
      .select('user_id,strategy_id,as_of_date,basket_value_cents,"1d_pct"')
      .gte("as_of_date", from).lte("as_of_date", to)
      .order("as_of_date", { ascending: false }).range(start, start + 999);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

export async function GET(request: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!isRetailSupabaseConfigured() || !isSupabaseConfigured())
    return NextResponse.json({ ok: false, error: "Retail or institutional Supabase is not configured" }, { status: 503 });

  const retail = createRetailServiceRoleClient();
  const institutional = createInstitutionalServiceRoleClient();
  const url = new URL(request.url);
  const today = sastDate();
  const from = url.searchParams.get("from") || `${today.slice(0, 4)}-01-01`;
  const to = url.searchParams.get("to") || today;
  // JSON timestamps are stored as UTC ISO strings. Convert the SAST day
  // boundary to the same representation before PostgREST compares the text.
  const todayStart = new Date(`${today}T00:00:00+02:00`).toISOString();
  const todayEnd = new Date(`${today}T23:59:59.999+02:00`).toISOString();

  const [scope, holdingsResult, securitiesResult, history, fillsResult] = await Promise.all([
    loadRetailLiveScope(retail),
    retail.from("stock_holdings_c").select("id,user_id,family_member_id,strategy_id,security_id,quantity,is_active,trade_side"),
    retail.from("securities_c").select("id,symbol"),
    loadHistory(retail, from, to),
    institutional.from("oems_order_audit")
      .select("side,quantity,payload,result_payload,status")
      .in("status", ["partial", "filled"])
      .gte("payload->>lastFillAt", todayStart)
      .lte("payload->>lastFillAt", todayEnd),
  ]);
  if (holdingsResult.error || securitiesResult.error || fillsResult.error) {
    const error = holdingsResult.error || securitiesResult.error || fillsResult.error;
    return NextResponse.json({ ok: false, error: error?.message || "Day P&L query failed" }, { status: 500 });
  }

  const securityById = new Map((securitiesResult.data ?? []).map((row) => [String(row.id), String(row.symbol)]));
  // Platform Day P&L covers the entire LIVE investor book. A direct/manual
  // security legitimately has no strategy_id and must not disappear merely
  // because it is outside a managed basket.
  const allHoldings = (holdingsResult.data ?? []).filter((row) => row.user_id && row.security_id &&
    !scope.excludedUserIds.has(String(row.user_id)) &&
    (!row.strategy_id || !scope.excludedStrategyIds.has(String(row.strategy_id))));
  const holdingById = new Map(allHoldings.map((row) => [String(row.id), row]));
  const currentByKey = new Map<string, { userId: string; strategyId: string | null; securityId: string; quantity: number }>();
  for (const row of allHoldings.filter((holding) => holding.is_active && String(holding.trade_side).toUpperCase() === "BUY")) {
    const strategyId = row.strategy_id ? String(row.strategy_id) : null;
    const key = keyOf(String(row.user_id), row.family_member_id ? String(row.family_member_id) : null, strategyId, String(row.security_id));
    const current = currentByKey.get(key) ?? { userId: String(row.user_id), strategyId, securityId: String(row.security_id), quantity: 0 };
    current.quantity += Math.abs(finite(row.quantity));
    currentByKey.set(key, current);
  }

  type Fill = { quantity: number; fillPriceCents: number };
  const fillsByKey = new Map<string, { buys: Fill[]; sells: Fill[] }>();
  for (const row of fillsResult.data ?? []) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const holding = typeof payload.holding_id === "string" ? holdingById.get(payload.holding_id) : undefined;
    const userId = String(holding?.user_id ?? payload.user_id ?? "");
    const familyId = holding?.family_member_id ? String(holding.family_member_id) : typeof payload.family_member_id === "string" ? payload.family_member_id : null;
    // When the holding is known, its null strategy_id is meaningful: this is
    // a direct security. Do not replace it with payload labels such as MANUAL.
    const strategyId = resolveDayPnlStrategyId(holding, payload.strategy_id);
    const securityId = String(holding?.security_id ?? payload.security_id ?? "");
    const quantity = finite(payload.filled ?? row.quantity);
    const resultPayload = (row.result_payload ?? {}) as Record<string, unknown>;
    const fillPriceCents = finite(resultPayload.avgFillPrice ?? payload.avgPx);
    if (!userId || !securityId || !(quantity > 0) || !(fillPriceCents > 0) ||
      scope.excludedUserIds.has(userId) || (strategyId != null && scope.excludedStrategyIds.has(strategyId))) continue;
    const key = keyOf(userId, familyId, strategyId, securityId);
    const bucket = fillsByKey.get(key) ?? { buys: [], sells: [] };
    (String(row.side).toLowerCase() === "sell" ? bucket.sells : bucket.buys).push({ quantity, fillPriceCents });
    fillsByKey.set(key, bucket);
    if (!currentByKey.has(key)) currentByKey.set(key, { userId, strategyId, securityId, quantity: 0 });
  }

  const securityIds = [...new Set([...currentByKey.values()].map((row) => row.securityId))];
  const [latestResult, closesResult] = securityIds.length ? await Promise.all([
    retail.from("securities_with_latest_quote")
      .select("security_id,symbol,latest_intraday_price,latest_intraday_at")
      .in("security_id", securityIds),
    retail.from("stock_returns_c")
      .select("security_id,current_price,as_of_date")
      .in("security_id", securityIds)
      .lt("as_of_date", today)
      .order("as_of_date", { ascending: false })
      .limit(5000),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (latestResult.error || closesResult.error) {
    return NextResponse.json({ ok: false, error: (latestResult.error || closesResult.error)?.message || "Price evidence query failed" }, { status: 500 });
  }

  const previousCloseById = new Map<string, number>();
  for (const row of closesResult.data ?? []) {
    const id = String(row.security_id ?? "");
    if (id && !previousCloseById.has(id) && finite(row.current_price) > 0) previousCloseById.set(id, finite(row.current_price));
  }
  const quoteBySecurityId = new Map<string, YahooTruthQuote>();
  for (const row of latestResult.data ?? []) {
    const id = String(row.security_id ?? "");
    const current = finite(row.latest_intraday_price);
    const previous = previousCloseById.get(id);
    const exchangeTime = String(row.latest_intraday_at ?? "");
    if (!id || !(current > 0) || !(previous && previous > 0) || !exchangeTime || sastDate(new Date(exchangeTime)) !== today) continue;
    quoteBySecurityId.set(id, {
      symbol: String(row.symbol ?? securityById.get(id) ?? ""), yahooSymbol: "", priceCents: current,
      previousCloseCents: previous, dailyChangeCents: current - previous,
      dailyChangePct: ((current - previous) / previous) * 100, currency: "ZAR",
      exchangeTime, fetchedAt: new Date().toISOString(), source: "Yahoo Finance chart API",
    });
  }

  const fallbackIds = securityIds.filter((id) => !quoteBySecurityId.has(id));
  const fallbackSymbols = fallbackIds.map((id) => securityById.get(id)).filter((symbol): symbol is string => Boolean(symbol));
  const normalizedFallbackSymbols = fallbackSymbols.map((symbol) => symbol.trim().toUpperCase());
  const persistedQuotes = new Map<string, { refreshedAt: number; quote: YahooTruthQuote }>();
  let persistentQuoteCacheAvailable = true;
  if (normalizedFallbackSymbols.length) {
    const persistedResult = await retail.from("day_pnl_quote_cache_c")
      .select("symbol,price_cents,previous_close_cents,exchange_time,fetched_at")
      .in("symbol", normalizedFallbackSymbols);
    if (persistedResult.error) {
      persistentQuoteCacheAvailable = false;
    } else {
      for (const row of persistedResult.data ?? []) {
        const symbol = String(row.symbol ?? "").trim().toUpperCase();
        const priceCents = finite(row.price_cents);
        const previousCloseCents = finite(row.previous_close_cents);
        const exchangeTime = String(row.exchange_time ?? "");
        const fetchedAt = String(row.fetched_at ?? "");
        if (!symbol || !(priceCents > 0) || !(previousCloseCents > 0) || !exchangeTime || !fetchedAt) continue;
        persistedQuotes.set(symbol, {
          refreshedAt: Date.parse(fetchedAt),
          quote: {
            symbol, yahooSymbol: `${symbol}.JO`, priceCents, previousCloseCents,
            dailyChangeCents: priceCents - previousCloseCents,
            dailyChangePct: ((priceCents - previousCloseCents) / previousCloseCents) * 100,
            currency: "ZAR", exchangeTime, fetchedAt, source: "Yahoo Finance chart API",
          },
        });
      }
    }
  }
  const { quotes: fallbackQuotes, refreshed } = await loadQuotes(fallbackSymbols, persistedQuotes);
  if (persistentQuoteCacheAvailable && refreshed.length) {
    const cacheWrite = await retail.from("day_pnl_quote_cache_c").upsert(refreshed.map((quote) => ({
      symbol: quote.symbol.trim().toUpperCase(),
      price_cents: quote.priceCents,
      previous_close_cents: quote.previousCloseCents,
      exchange_time: quote.exchangeTime,
      fetched_at: quote.fetchedAt,
    })), { onConflict: "symbol" });
    if (cacheWrite.error) persistentQuoteCacheAvailable = false;
  }
  for (const id of fallbackIds) {
    const symbol = securityById.get(id);
    const quote = symbol ? fallbackQuotes.get(symbol.trim().toUpperCase()) : undefined;
    if (quote) quoteBySecurityId.set(id, quote);
  }
  let totalPnlCents = 0;
  const byStrategy = new Map<string, number>();
  const coveredKeys = new Set<string>();
  let newestExchangeTime: string | null = null;
  for (const [key, position] of currentByKey) {
    const quote = quoteBySecurityId.get(position.securityId);
    if (!quote || quote.previousCloseCents == null || sastDate(new Date(quote.exchangeTime)) !== today) continue;
    const fills = fillsByKey.get(key) ?? { buys: [], sells: [] };
    const pnl = calculateAssetDayPnlCents({
      currentQuantity: position.quantity,
      currentPriceCents: quote.priceCents,
      previousCloseCents: quote.previousCloseCents,
      buys: fills.buys,
      sells: fills.sells,
    });
    totalPnlCents += pnl;
    if (position.strategyId != null) {
      byStrategy.set(position.strategyId, (byStrategy.get(position.strategyId) ?? 0) + pnl);
    }
    coveredKeys.add(key);
    if (!newestExchangeTime || quote.exchangeTime > newestExchangeTime) newestExchangeTime = quote.exchangeTime;
  }
  const liveComplete = currentByKey.size > 0 && coveredKeys.size === currentByKey.size;
  const directPositions = [...currentByKey.values()].filter((position) => position.strategyId == null).length;
  const strategyPositions = currentByKey.size - directPositions;
  const missingSymbols = [...new Set([...currentByKey]
    .filter(([key]) => !coveredKeys.has(key))
    .map(([, position]) => securityById.get(position.securityId) ?? position.securityId))]
    .sort();

  const historyByDate = new Map<string, { pnlCents: number; strategies: Set<string>; investors: Set<string> }>();
  for (const row of history) {
    if (scope.excludedUserIds.has(String(row.user_id)) || scope.excludedStrategyIds.has(String(row.strategy_id))) continue;
    const date = String(row.as_of_date);
    const bucket = historyByDate.get(date) ?? { pnlCents: 0, strategies: new Set(), investors: new Set() };
    const value = finite(row.basket_value_cents);
    const rate = finite(row["1d_pct"]) / 100;
    if (1 + rate > 0) bucket.pnlCents += Math.round(value - value / (1 + rate));
    bucket.strategies.add(String(row.strategy_id));
    bucket.investors.add(String(row.user_id));
    historyByDate.set(date, bucket);
  }

  return NextResponse.json({
    ok: true,
    today: {
      date: today,
      pnl: liveComplete ? totalPnlCents / 100 : null,
      byStrategy: liveComplete ? Object.fromEntries([...byStrategy].map(([id, cents]) => [id, cents / 100])) : {},
      status: liveComplete ? "live" : "stale",
      source: "Supabase intraday with bounded Yahoo fallback; opening units vs previous close; intraday trades vs actual fill",
      asOf: newestExchangeTime,
      coveredHoldings: coveredKeys.size,
      totalHoldings: currentByKey.size,
      directPositions,
      strategyPositions,
      coveredSecurities: securityIds.length - missingSymbols.length,
      totalSecurities: securityIds.length,
      missingSymbols,
      quoteCache: persistentQuoteCacheAvailable ? "persistent" : "memory-only",
      feesIncluded: false,
    },
    history: [...historyByDate.entries()]
      .filter(([date]) => date !== today)
      .map(([date, row]) => ({ date, pnl: row.pnlCents / 100, strategies: row.strategies.size, investors: row.investors.size }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  });
}
