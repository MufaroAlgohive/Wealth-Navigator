import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";
import { calculateAssetDayPnlCents } from "@/lib/pnl/asset-day-pnl";
import {
  createInstitutionalServiceRoleClient,
  createRetailServiceRoleClient,
  isRetailSupabaseConfigured,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import { fetchYahooTruthQuote, type YahooTruthQuote } from "@/lib/truth/yahoo-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTE_CACHE_MS = 25_000;
const quoteCache = new Map<string, { expiresAt: number; quote: YahooTruthQuote }>();
const sastDate = (value = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
}).format(value);
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const keyOf = (userId: string, familyId: string | null, strategyId: string, securityId: string) =>
  `${userId}|${familyId ?? ""}|${strategyId}|${securityId}`;

async function cachedQuote(symbol: string): Promise<YahooTruthQuote> {
  const key = symbol.trim().toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;
  const quote = await fetchYahooTruthQuote(symbol);
  quoteCache.set(key, { quote, expiresAt: Date.now() + QUOTE_CACHE_MS });
  return quote;
}

async function loadQuotes(symbols: string[]): Promise<Map<string, YahooTruthQuote>> {
  const output = new Map<string, YahooTruthQuote>();
  // Yahoo is a bounded fallback, never the platform-wide polling feed.
  for (let start = 0; start < Math.min(symbols.length, 8); start += 2) {
    const chunk = symbols.slice(start, Math.min(start + 2, 8));
    const settled = await Promise.allSettled(chunk.map(cachedQuote));
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") output.set(chunk[index]!, result.value);
    });
  }
  return output;
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
  const allHoldings = (holdingsResult.data ?? []).filter((row) => row.user_id && row.strategy_id && row.security_id &&
    !scope.excludedUserIds.has(String(row.user_id)) && !scope.excludedStrategyIds.has(String(row.strategy_id)));
  const holdingById = new Map(allHoldings.map((row) => [String(row.id), row]));
  const currentByKey = new Map<string, { userId: string; strategyId: string; securityId: string; quantity: number }>();
  for (const row of allHoldings.filter((holding) => holding.is_active && String(holding.trade_side).toUpperCase() === "BUY")) {
    const key = keyOf(String(row.user_id), row.family_member_id ? String(row.family_member_id) : null, String(row.strategy_id), String(row.security_id));
    const current = currentByKey.get(key) ?? { userId: String(row.user_id), strategyId: String(row.strategy_id), securityId: String(row.security_id), quantity: 0 };
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
    const strategyId = String(holding?.strategy_id ?? payload.strategy_id ?? "");
    const securityId = String(holding?.security_id ?? payload.security_id ?? "");
    const quantity = finite(payload.filled ?? row.quantity);
    const resultPayload = (row.result_payload ?? {}) as Record<string, unknown>;
    const fillPriceCents = finite(resultPayload.avgFillPrice ?? payload.avgPx);
    if (!userId || !strategyId || !securityId || !(quantity > 0) || !(fillPriceCents > 0) ||
      scope.excludedUserIds.has(userId) || scope.excludedStrategyIds.has(strategyId)) continue;
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
  const fallbackQuotes = await loadQuotes(fallbackSymbols);
  for (const id of fallbackIds) {
    const symbol = securityById.get(id);
    const quote = symbol ? fallbackQuotes.get(symbol) : undefined;
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
    byStrategy.set(position.strategyId, (byStrategy.get(position.strategyId) ?? 0) + pnl);
    coveredKeys.add(key);
    if (!newestExchangeTime || quote.exchangeTime > newestExchangeTime) newestExchangeTime = quote.exchangeTime;
  }
  const liveComplete = currentByKey.size > 0 && coveredKeys.size === currentByKey.size;

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
      feesIncluded: false,
    },
    history: [...historyByDate.entries()]
      .filter(([date]) => date !== today)
      .map(([date, row]) => ({ date, pnl: row.pnlCents / 100, strategies: row.strategies.size, investors: row.investors.size }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  });
}
