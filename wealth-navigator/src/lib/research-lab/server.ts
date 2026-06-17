import {
  createRetailServiceRoleClient,
  isRetailSupabaseConfigured,
  createServiceRoleClient,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import {
  buildFundamentals,
  buildHoldings,
  computeSectors,
  computeTotals,
  parseHoldingsJson,
  securitiesMap,
  type SecurityRef,
} from "@/lib/research-lab/compose-basket";
import type { ResearchLabListItem, ResearchLabPayload } from "@/lib/research-lab/types";

const bare = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

const SEC_SELECT =
  "symbol,name,sector,industry,last_price,pe,eps,dividend_yield,beta,market_cap,ytd_performance";

async function overlayIressQuotes(rows: SecurityRef[]): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  try {
    const inst = createServiceRoleClient();
    const { data } = await inst.from("quote_snapshot_c").select("security_code,last,prev_close");
    if (!data) return 0;
    const snap = new Map<string, number>();
    for (const s of data as Array<{ security_code: string; last: number | null }>) {
      if (s.last != null && s.last > 0) snap.set(String(s.security_code).toUpperCase(), s.last);
    }
    let n = 0;
    for (const r of rows) {
      const last = snap.get(bare(r.symbol));
      if (last != null) {
        r.last_price = Math.round(last);
        r.price_source = "iress";
        n++;
      } else {
        r.price_source = "yahoo";
      }
    }
    return n;
  } catch {
    return 0;
  }
}

async function loadSecurities(tickers: string[]): Promise<{ rows: SecurityRef[]; iressOverlay: number }> {
  const supabase = createRetailServiceRoleClient();
  const { data } = await supabase.from("securities_c").select(SEC_SELECT);
  const all = (data ?? []) as SecurityRef[];
  const want = new Set(tickers.map(bare));
  const subset = all.filter((r) => want.has(bare(r.symbol)));
  const iressOverlay = await overlayIressQuotes(subset);
  return { rows: subset, iressOverlay };
}

interface StrategyRow {
  id: string;
  name: string | null;
  slug: string | null;
  sector: string | null;
  provider_name: string | null;
  benchmark_name: string | null;
  benchmark_symbol: string | null;
  status: string | null;
  holdings: unknown;
  min_investment: number | null;
  updated_at: string | null;
  description?: string | null;
}

export async function listResearchStrategies(): Promise<{
  strategies: ResearchLabListItem[];
  source: string;
}> {
  if (!isRetailSupabaseConfigured()) {
    return { strategies: [], source: "unavailable" };
  }
  const retail = createRetailServiceRoleClient();
  const { data, error } = await retail
    .from("strategies_c")
    .select("id,name,benchmark_name,benchmark_symbol,status,holdings,min_investment")
    .order("name");
  if (error) throw error;
  const strategies = ((data ?? []) as StrategyRow[]).map((s) => ({
    id: s.id,
    name: s.name ?? "Strategy",
    benchmark: s.benchmark_name ?? s.benchmark_symbol ?? "—",
    holdingsCount: Array.isArray(s.holdings) ? s.holdings.length : 0,
    minInvestment: Number(s.min_investment) || 0,
    status: String(s.status ?? "—"),
  }));
  return { strategies, source: "retail-supabase" };
}

export async function loadResearchLab(
  strategyId: string,
  extraTickers: string[] = [],
): Promise<ResearchLabPayload> {
  if (!isRetailSupabaseConfigured()) {
    return {
      source: "unavailable",
      reason: "supabase_not_configured",
      strategy: emptyMeta(strategyId),
      current: { holdings: [], totals: zeroTotals(), sectors: [] },
      proposed: null,
      fundamentals: [],
      tickers: [],
      gaps: ["Retail Supabase not configured."],
    };
  }

  const retail = createRetailServiceRoleClient();
  const { data, error } = await retail
    .from("strategies_c")
    .select(
      "id,name,slug,sector,provider_name,benchmark_name,benchmark_symbol,status,holdings,min_investment,updated_at,description",
    )
    .eq("id", strategyId)
    .maybeSingle();

  if (error || !data) {
    return {
      source: "unavailable",
      reason: error?.message ?? "not_found",
      strategy: emptyMeta(strategyId),
      current: { holdings: [], totals: zeroTotals(), sectors: [] },
      proposed: null,
      fundamentals: [],
      tickers: [],
      gaps: ["Strategy not found in strategies_c."],
    };
  }

  const row = data as StrategyRow;
  const raw = parseHoldingsJson(row.holdings);
  const hasPending = raw.some((h) => h.pending);
  const tickers = [
    ...new Set([
      ...raw.map((h) => bare(String(h.symbol ?? h.ticker ?? ""))).filter(Boolean),
      ...extraTickers.map(bare).filter(Boolean),
    ]),
  ];

  const { rows: secRows, iressOverlay } = await loadSecurities(tickers);
  const secMap = securitiesMap(secRows);

  // Published basket minimum from retail catalogue (Rands).
  const basketMin = Number(row.min_investment) || 0;

  const currentHoldings = buildHoldings(raw, secMap, basketMin, { includePending: false });
  const proposedHoldings = hasPending ? buildHoldings(raw, secMap, basketMin, { includePending: true }) : null;

  const currentTotals = computeTotals(currentHoldings, basketMin);
  const proposedTotals = proposedHoldings ? computeTotals(proposedHoldings, basketMin) : null;

  const { metrics, gaps } = buildFundamentals(tickers, secMap);

  // Investor / AUM rollup from latest client_strategy_returns_c snapshot.
  let investorCount = 0;
  let aum = 0;
  const { data: latestDate } = await retail
    .from("client_strategy_returns_c")
    .select("as_of_date")
    .order("as_of_date", { ascending: false })
    .limit(1);
  const asOfDate = (latestDate?.[0]?.as_of_date as string | undefined) ?? row.updated_at;
  if (asOfDate) {
    const { data: returns } = await retail
      .from("client_strategy_returns_c")
      .select("user_id,basket_value")
      .eq("strategy_id", strategyId)
      .eq("as_of_date", asOfDate);
    const users = new Set<string>();
    for (const r of (returns ?? []) as Array<{ user_id?: string; basket_value?: number }>) {
      if (r.user_id) users.add(r.user_id);
      aum += Number(r.basket_value ?? 0) / 100;
    }
    investorCount = users.size;
  }

  const asOf = row.updated_at
    ? new Date(row.updated_at).toLocaleDateString("en-ZA", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

  return {
    source: "retail-supabase",
    strategy: {
      id: row.id,
      name: row.name ?? "Strategy",
      description: row.description ?? row.sector ?? null,
      benchmark: row.benchmark_name ?? row.benchmark_symbol ?? "—",
      manager: row.provider_name ?? "—",
      status: investorCount > 0 ? "Has investors" : String(row.status ?? "—"),
      inception: row.updated_at ? new Date(row.updated_at).toLocaleDateString("en-ZA") : null,
      minInvestment: basketMin,
      investorCount,
      aum,
      asOf,
    },
    current: {
      holdings: currentHoldings,
      totals: currentTotals,
      sectors: computeSectors(currentHoldings, currentTotals.cashPct),
    },
    proposed: proposedHoldings
      ? {
          holdings: proposedHoldings,
          totals: proposedTotals!,
          sectors: computeSectors(proposedHoldings, proposedTotals!.cashPct),
        }
      : null,
    fundamentals: metrics,
    tickers,
    gaps,
    iressOverlay,
  };
}

function zeroTotals() {
  return { constituent: 0, cash: 0, cashPct: 0, basketMin: 0 };
}

function emptyMeta(id: string) {
  return {
    id,
    name: "—",
    description: null,
    benchmark: "—",
    manager: "—",
    status: "—",
    inception: null,
    minInvestment: 0,
    investorCount: 0,
    aum: 0,
    asOf: "—",
  };
}
