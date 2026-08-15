import { YahooProvider } from "../src/lib/data/providers/yahoo";
import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const START_DATE = "2026-03-20";
const END_DATE = "2026-08-14";
const SYMBOLS = ["SYGEMF", "STXWDM", "STXID", "STXNDQ", "GLPROP"];
const db = createRetailServiceRoleClient();
const yahoo = new YahooProvider();

async function rows<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const [sessions, storedPrices, yahooSeries] = await Promise.all([
  rows(
    "JSE sessions",
    db
      .from("jse_trading_calendar")
      .select("trading_date")
      .eq("market", "JSE_EQUITIES")
      .eq("is_trading_day", true)
      .gte("trading_date", START_DATE)
      .lte("trading_date", END_DATE)
      .order("trading_date"),
  ),
  rows(
    "stored ETF closes",
    db
      .from("stock_returns_c")
      .select("symbol, as_of_date, current_price, fetched_at")
      .in("symbol", SYMBOLS.flatMap((symbol) => [symbol, `${symbol}.JO`]))
      .gte("as_of_date", START_DATE)
      .lte("as_of_date", END_DATE)
      .order("fetched_at"),
  ),
  Promise.all(SYMBOLS.map(async (symbol) => ({ symbol, bars: await yahoo.fetchHistory(`${symbol}.JO`, "1Y") }))),
]);

const sessionDates = new Set(sessions.map((session) => session.trading_date));
const storedByKey = new Map<string, number>();
for (const price of storedPrices) {
  const symbol = String(price.symbol).replace(/\.(JO|JSE)$/i, "").toUpperCase();
  if (!sessionDates.has(price.as_of_date)) continue;
  storedByKey.set(`${symbol}:${price.as_of_date}`, Number(price.current_price));
}

const results = yahooSeries.map(({ symbol, bars }) => {
  const yahooByDate = new Map(
    bars
      .map((bar) => [bar.timestamp.slice(0, 10), Math.round(Number(bar.close) * 100)] as const)
      .filter(([date, close]) => date >= START_DATE && date <= END_DATE && close > 0),
  );
  const comparisons = [...sessionDates]
    .sort()
    .map((date) => {
      const stored = storedByKey.get(`${symbol}:${date}`) ?? null;
      const yahooClose = yahooByDate.get(date) ?? null;
      return {
        date,
        stored_cents: stored,
        yahoo_cents: yahooClose,
        variance_cents: stored == null || yahooClose == null ? null : stored - yahooClose,
      };
    });
  const comparable = comparisons.filter((row) => row.variance_cents != null);
  const mismatches = comparable.filter((row) => row.variance_cents !== 0);
  return {
    symbol,
    yahoo_points_in_window: yahooByDate.size,
    session_count: sessionDates.size,
    compared_count: comparable.length,
    exact_match_count: comparable.length - mismatches.length,
    missing_stored_dates: comparisons.filter((row) => row.stored_cents == null).map((row) => row.date),
    missing_yahoo_dates: comparisons.filter((row) => row.yahoo_cents == null).map((row) => row.date),
    max_absolute_variance_cents:
      mismatches.length === 0 ? 0 : Math.max(...mismatches.map((row) => Math.abs(Number(row.variance_cents)))),
    mismatch_sample: mismatches.slice(0, 20),
  };
});

console.log(
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      start_date: START_DATE,
      end_date: END_DATE,
      results,
      certification_ready: results.every(
        (result) =>
          result.missing_stored_dates.length === 0 &&
          result.compared_count > 0 &&
          result.max_absolute_variance_cents <= 1,
      ),
    },
    null,
    2,
  ),
);
