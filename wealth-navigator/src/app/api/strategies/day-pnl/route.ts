import { NextResponse } from "next/server";

import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import { fetchYahooTruthQuote } from "@/lib/truth/yahoo-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sastDate = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

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
  if (!isRetailSupabaseConfigured())
    return NextResponse.json({ ok: false, error: "Retail Supabase is not configured" }, { status: 503 });

  const db = createRetailServiceRoleClient();
  const url = new URL(request.url);
  const from = url.searchParams.get("from") || `${new Date().getUTCFullYear()}-01-01`;
  const to = url.searchParams.get("to") || sastDate();

  const [scope, holdingsResult, securitiesResult, history] = await Promise.all([
    loadRetailLiveScope(db),
    db.from("stock_holdings_c").select("user_id,strategy_id,security_id,quantity").eq("is_active", true).eq("trade_side", "BUY"),
    db.from("securities_c").select("id,symbol"),
    loadHistory(db, from, to),
  ]);
  if (holdingsResult.error || securitiesResult.error) {
    const error = holdingsResult.error || securitiesResult.error;
    return NextResponse.json({ ok: false, error: error?.message || "Day P&L query failed" }, { status: 500 });
  }

  const securityById = new Map((securitiesResult.data ?? []).map((row) => [String(row.id), String(row.symbol)]));
  const holdings = (holdingsResult.data ?? []).filter((row) =>
    row.user_id && row.strategy_id && row.security_id &&
    !scope.excludedUserIds.has(String(row.user_id)) && !scope.excludedStrategyIds.has(String(row.strategy_id)));
  const symbols = [...new Set(holdings.map((row) => securityById.get(String(row.security_id))).filter((symbol): symbol is string => Boolean(symbol)))];
  const quoteResults = await Promise.allSettled(symbols.map((symbol) => fetchYahooTruthQuote(symbol)));
  const quoteBySymbol = new Map(quoteResults.flatMap((result) => result.status === "fulfilled" ? [[result.value.symbol, result.value] as const] : []));

  let todayPnlCents = 0;
  const todayByStrategy = new Map<string, number>();
  let coveredHoldings = 0;
  let newestExchangeTime: string | null = null;
  for (const holding of holdings) {
    const quote = quoteBySymbol.get(securityById.get(String(holding.security_id)) || "");
    if (!quote || quote.dailyChangeCents == null) continue;
    const holdingPnl = Math.round(Math.abs(finite(holding.quantity)) * quote.dailyChangeCents);
    todayPnlCents += holdingPnl;
    const strategyId = String(holding.strategy_id);
    todayByStrategy.set(strategyId, (todayByStrategy.get(strategyId) ?? 0) + holdingPnl);
    coveredHoldings += 1;
    if (!newestExchangeTime || quote.exchangeTime > newestExchangeTime) newestExchangeTime = quote.exchangeTime;
  }
  const today = sastDate();
  const quoteDate = newestExchangeTime ? sastDate(new Date(newestExchangeTime)) : null;
  const liveComplete = holdings.length > 0 && coveredHoldings === holdings.length && quoteDate === today;

  const historyByDate = new Map<string, { pnlCents: number; strategies: Set<string>; investors: Set<string> }>();
  for (const row of history) {
    if (scope.excludedUserIds.has(String(row.user_id)) || scope.excludedStrategyIds.has(String(row.strategy_id))) continue;
    const date = String(row.as_of_date);
    const bucket = historyByDate.get(date) ?? { pnlCents: 0, strategies: new Set(), investors: new Set() };
    const value = finite(row.basket_value_cents);
    const rate = finite(row["1d_pct"]) / 100;
    // basket_value is the period numerator. Recover the denominator before
    // deriving Rand P&L; value * rate would be subtly wrong for non-zero days.
    if (1 + rate > 0) bucket.pnlCents += Math.round(value - value / (1 + rate));
    bucket.strategies.add(String(row.strategy_id));
    bucket.investors.add(String(row.user_id));
    historyByDate.set(date, bucket);
  }

  return NextResponse.json({
    ok: true,
    today: { date: today, pnl: liveComplete ? todayPnlCents / 100 : null, byStrategy: liveComplete ? Object.fromEntries([...todayByStrategy].map(([id, cents]) => [id, cents / 100])) : {}, status: liveComplete ? "live" : "stale", source: "Yahoo current price vs previous close", asOf: newestExchangeTime, coveredHoldings, totalHoldings: holdings.length },
    history: [...historyByDate.entries()].map(([date, row]) => ({ date, pnl: row.pnlCents / 100, strategies: row.strategies.size, investors: row.investors.size })).sort((a, b) => b.date.localeCompare(a.date)),
  });
}
