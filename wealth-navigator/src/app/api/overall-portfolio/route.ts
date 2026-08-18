/**
 * GET /api/overall-portfolio
 * GET /api/overall-portfolio?investor=<user_id>
 *
 * Phase A6 — "Overall Portfolio" panel for the OEMS Cockpit. Powers the
 * investor drill-down list and the 1D / 1M / YTD per-strategy performance
 * view. Reads the RETAIL prod DB:
 *
 *   - `client_strategy_returns_c`  — daily basket_value / day / ytd pnl per
 *     (user, strategy). Latest snapshot across the book; investor-scoped
 *     when `?investor=` is provided.
 *   - `stock_holdings_c`           — active holdings count per investor (or
 *     platform-wide).
 *   - `strategies_c`               — strategy name + status (`status='live'`
 *     filter, same policy as `/api/client-book`).
 *   - `profiles`                   — investor names + `is_test` filter.
 *
 * Returns:
 *   - aggregate path: KPI totals + a flat list of investors (name, email,
 *     book value) for the dropdown.
 *   - per-investor path: a single investor + per-strategy rows + a per-day /
 *     per-month / ytd time series for the chart at the bottom of the panel.
 *
 * All money values are RANDS. Money fields stored as integer CENTS in the DB
 * are divided by 100 once, here.
 *
 * P&L MTD is null today (no period-returns worker yet) — the UI surfaces an
 * honest "—" instead of a fabricated number.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ClientStrategyReturnRow {
  user_id: string;
  strategy_id: string;
  as_of_date: string;
  basket_value_cents: number | null;
  "1d_pct": number | null;
  ytd_pct: number | null;
}

/** P&L in Rands implied by a stored pct against the CURRENT basket value —
 * same back-out formula useUserStrategies.js and /api/client-book use. */
function pnlRandsFromPct(basketRands: number, pct: number | null): number {
  if (pct == null || !Number.isFinite(pct)) return 0;
  return basketRands - basketRands / (1 + pct / 100);
}

interface StrategyRow {
  id: string;
  name: string | null;
  status: string | null;
}

interface ProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_test: boolean | null;
}

interface StrategyReturnsHistoryRow {
  strategy_id: string;
  as_of_date: string;
  basket_value: number | string | null;
}

function num(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function investorName(p: ProfileRow): string {
  const f = (p.first_name ?? "").trim();
  const l = (p.last_name ?? "").trim();
  const composed = `${f} ${l}`.trim();
  if (composed) return composed;
  if (p.email) return p.email;
  return p.id.slice(0, 8);
}

const RETURNS_SELECT = 'user_id,strategy_id,as_of_date,basket_value_cents,"1d_pct","ytd_pct"';

interface AggregateEnvelope {
  source: "retail-supabase" | "unavailable";
  asOf: string | null;
  investors: number;
  holdings: number;
  total: number;
  dayPnl: number;
  mtdPnl: number | null;
  ytdPnl: number;
  investors_list: Array<{ id: string; name: string; email: string | null; bookValue: number }>;
  reason?: string;
  error?: string;
}

interface PerInvestorEnvelope {
  source: "retail-supabase" | "unavailable";
  asOf: string | null;
  investor: { id: string; name: string; email: string | null } | null;
  total: number;
  holdings: number;
  strategies: Array<{
    strategyId: string;
    strategyName: string;
    basketValue: number;
    dayPnl: number;
    mtdPnl: number | null;
    ytdPnl: number;
    dayPct: number | null;
    ytdPct: number | null;
  }>;
  history: {
    days: Array<{ t: number; v: number }>;
    months: Array<{ t: number; v: number }>;
    ytd: Array<{ t: number; v: number }>;
  };
  reason?: string;
  error?: string;
}

async function getStrategyMap(
  supabase: ReturnType<typeof createRetailServiceRoleClient>,
): Promise<Map<string, string>> {
  const { data } = await supabase.from("strategies_c").select("id, name, status").eq("status", "live");
  const m = new Map<string, string>();
  for (const s of (data ?? []) as Array<StrategyRow & { name: string | null }>) {
    if (s.name) m.set(s.id, s.name);
  }
  return m;
}

async function getProfileMap(
  supabase: ReturnType<typeof createRetailServiceRoleClient>,
): Promise<Map<string, ProfileRow>> {
  const { data } = await supabase.from("profiles").select("id, first_name, last_name, email, is_test");
  const m = new Map<string, ProfileRow>();
  for (const p of (data ?? []) as ProfileRow[]) m.set(p.id, p);
  return m;
}

/**
 * Aggregate path: latest snapshot across the entire RETAIL book, limited to
 * LIVE strategies and non-test profiles.
 */
async function buildAggregate(
  supabase: ReturnType<typeof createRetailServiceRoleClient>,
  strategyMap: Map<string, string>,
  profileMap: Map<string, ProfileRow>,
): Promise<AggregateEnvelope> {
  const { data: latestRows, error: latestError } = await supabase
    .from("client_strategy_returns_effective_c")
    .select("as_of_date")
    .order("as_of_date", { ascending: false })
    .limit(1);
  if (latestError) {
    return {
      source: "unavailable",
      asOf: null,
      investors: 0,
      holdings: 0,
      total: 0,
      dayPnl: 0,
      mtdPnl: null,
      ytdPnl: 0,
      investors_list: [],
      reason: "supabase_query_failed",
      error: latestError.message,
    };
  }
  const asOf = (latestRows?.[0]?.as_of_date as string | undefined) ?? null;
  if (!asOf) {
    return {
      source: "unavailable",
      asOf: null,
      investors: 0,
      holdings: 0,
      total: 0,
      dayPnl: 0,
      mtdPnl: null,
      ytdPnl: 0,
      investors_list: [],
      reason: "empty",
    };
  }
  const { data: rows, error: rowsError } = await supabase
    .from("client_strategy_returns_effective_c")
    .select(RETURNS_SELECT)
    .eq("as_of_date", asOf);
  if (rowsError) {
    return {
      source: "unavailable",
      asOf,
      investors: 0,
      holdings: 0,
      total: 0,
      dayPnl: 0,
      mtdPnl: null,
      ytdPnl: 0,
      investors_list: [],
      reason: "supabase_query_failed",
      error: rowsError.message,
    };
  }
  const returns = (rows ?? []) as ClientStrategyReturnRow[];
  const investorAgg = new Map<string, { total: number; day: number; ytd: number }>();
  let total = 0;
  let dayPnl = 0;
  let ytdPnl = 0;
  let investorCount = 0;
  for (const r of returns) {
    if (!strategyMap.has(r.strategy_id)) continue;
    const profile = profileMap.get(r.user_id);
    if (profile?.is_test === true) continue;
    const basket = num(r.basket_value_cents) / 100;
    const day = pnlRandsFromPct(basket, r["1d_pct"]);
    const ytd = pnlRandsFromPct(basket, r.ytd_pct);
    total += basket;
    dayPnl += day;
    ytdPnl += ytd;
    const cur = investorAgg.get(r.user_id) ?? { total: 0, day: 0, ytd: 0 };
    cur.total += basket;
    cur.day += day;
    cur.ytd += ytd;
    investorAgg.set(r.user_id, cur);
  }

  // Distinct investors from `client_strategy_returns_c` — for a count that
  // includes investors with no live book yet we supplement with profiles later.
  investorCount = investorAgg.size;
  if (investorCount === 0) {
    // Backfill: count distinct non-test profiles even if they have no rows.
    for (const p of profileMap.values()) {
      if (p.is_test === true) continue;
      investorCount += 1;
    }
  }

  // Active holdings count (platform-wide).
  const { count: holdings } = await supabase
    .from("stock_holdings_c")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);

  // Investor list (dropdown). Union of (1) investors with live book rows
  // and (2) non-test profiles that have never shown up in `client_strategy_returns_c`
  // — keeps the dropdown useful when the returns snapshot is stale.
  const investorsList: AggregateEnvelope["investors_list"] = [];
  const seen = new Set<string>();
  // First: investors with a non-zero book value, sorted high→low.
  const sortedAgg = [...investorAgg.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [id, agg] of sortedAgg) {
    const p = profileMap.get(id);
    const name = p ? investorName(p) : id.slice(0, 8);
    investorsList.push({ id, name, email: p?.email ?? null, bookValue: agg.total });
    seen.add(id);
  }
  // Then: extra non-test profiles (0 book) so the dropdown shows the full set.
  for (const p of profileMap.values()) {
    if (seen.has(p.id)) continue;
    if (p.is_test === true) continue;
    investorsList.push({ id: p.id, name: investorName(p), email: p.email, bookValue: 0 });
    seen.add(p.id);
    if (investorsList.length >= 250) break; // safety cap — UI never paginates
  }

  return {
    source: "retail-supabase",
    asOf,
    investors: investorCount,
    holdings: holdings ?? 0,
    total,
    dayPnl,
    mtdPnl: null,
    ytdPnl,
    investors_list: investorsList,
  };
}

/**
 * Per-investor path: returns per-strategy rows + a per-day / per-month /
 * year-to-date time series for the bottom strip chart. One query per
 * granularity (1D/1M/YTD) — the chart picks the right one client-side.
 */
async function buildPerInvestor(
  supabase: ReturnType<typeof createRetailServiceRoleClient>,
  investorId: string,
  strategyMap: Map<string, string>,
  profileMap: Map<string, ProfileRow>,
): Promise<PerInvestorEnvelope> {
  const profile = profileMap.get(investorId);
  const investor: PerInvestorEnvelope["investor"] = profile
    ? { id: investorId, name: investorName(profile), email: profile.email }
    : null;

  // 1. Latest snapshot row per strategy for this investor.
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const yearStart = new Date(today.getFullYear(), 0, 1);

  const { data: snapRows, error: snapError } = await supabase
    .from("client_strategy_returns_effective_c")
    .select(RETURNS_SELECT)
    .eq("user_id", investorId);
  if (snapError) {
    return {
      source: "unavailable",
      asOf: null,
      investor,
      total: 0,
      holdings: 0,
      strategies: [],
      history: { days: [], months: [], ytd: [] },
      reason: "supabase_query_failed",
      error: snapError.message,
    };
  }
  // Pick latest as_of_date per strategy.
  const byStrategy = new Map<string, ClientStrategyReturnRow>();
  let asOf: string | null = null;
  for (const r of (snapRows ?? []) as ClientStrategyReturnRow[]) {
    if (!strategyMap.has(r.strategy_id)) continue;
    const prev = byStrategy.get(r.strategy_id);
    if (!prev || prev.as_of_date < r.as_of_date) {
      byStrategy.set(r.strategy_id, r);
      if (!asOf || asOf < r.as_of_date) asOf = r.as_of_date;
    }
  }
  const strategies = [...byStrategy.values()]
    .map((r) => {
      const basket = num(r.basket_value_cents) / 100;
      const dayPct = r["1d_pct"] != null && Number.isFinite(Number(r["1d_pct"])) ? Number(r["1d_pct"]) : null;
      const ytdPct = r.ytd_pct != null && Number.isFinite(Number(r.ytd_pct)) ? Number(r.ytd_pct) : null;
      return {
        strategyId: r.strategy_id,
        strategyName: strategyMap.get(r.strategy_id) ?? r.strategy_id,
        basketValue: basket,
        dayPnl: pnlRandsFromPct(basket, dayPct),
        mtdPnl: null,
        ytdPnl: pnlRandsFromPct(basket, ytdPct),
        dayPct,
        ytdPct,
      };
    })
    .sort((a, b) => b.basketValue - a.basketValue);

  const total = strategies.reduce((s, x) => s + x.basketValue, 0);

  // 2. Active holdings for this user.
  const { count: holdings } = await supabase
    .from("stock_holdings_c")
    .select("*", { count: "exact", head: true })
    .eq("user_id", investorId)
    .eq("is_active", true);

  // 3. Time series: pull the basket_value history for the LAST 1 day (24
  //    rows), the LAST month (≈ 22 trading days), and year-to-date, all
  //    rebalanced to their respective start dates. We approximate the longer
  //    windows from the same underlying series.
  // Was strategies_returns_c, the raw legacy table (not even the guarded
  // view) -- same class of gap as the aggregate P&L above. Reads the guarded
  // strategy-level view here rather than the certified canonical ledger: this
  // chart sums basket_value ACROSS the investor's several strategies into one
  // series, which the certified SI-index (a per-strategy 100-based index, not
  // a Rand figure) can't be summed into meaningfully without a proper
  // per-strategy currency rebase this approximation was never designed to do.
  const { data: histRaw } = await supabase
    .from("strategy_returns_effective_c")
    .select("strategy_id, as_of_date, basket_value")
    .in("strategy_id", strategies.length > 0 ? strategies.map((s) => s.strategyId) : ["__none__"])
    .order("as_of_date", { ascending: true });
  const series: Array<{ t: number; v: number }> = [];
  for (const r of (histRaw ?? []) as StrategyReturnsHistoryRow[]) {
    const v = Number(r.basket_value);
    if (!r.as_of_date || !Number.isFinite(v) || v <= 0) continue;
    series.push({ t: new Date(r.as_of_date).getTime(), v });
  }
  series.sort((a, b) => a.t - b.t);

  const sliceFrom = (start: number): Array<{ t: number; v: number }> => series.filter((p) => p.t >= start);

  return {
    source: "retail-supabase",
    asOf,
    investor,
    total,
    holdings: holdings ?? 0,
    strategies,
    history: {
      days: sliceFrom(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()),
      months: sliceFrom(monthStart.getTime()),
      ytd: sliceFrom(yearStart.getTime()),
    },
  };
}

export async function GET(req: Request) {
  if (!isRetailSupabaseConfigured()) {
    return Response.json({ source: "unavailable", reason: "supabase_not_configured" }, { status: 503 });
  }
  const supabase = createRetailServiceRoleClient();
  const url = new URL(req.url);
  const investor = url.searchParams.get("investor");

  const [strategyMap, profileMap] = await Promise.all([getStrategyMap(supabase), getProfileMap(supabase)]);

  if (investor) {
    return Response.json(await buildPerInvestor(supabase, investor, strategyMap, profileMap));
  }
  return Response.json(await buildAggregate(supabase, strategyMap, profileMap));
}
