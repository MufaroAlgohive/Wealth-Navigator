import {
  type SecurityRef,
  buildFundamentals,
  buildHoldings,
  computeSectors,
  computeTotals,
  parseHoldingsJson,
  securitiesMap,
} from "@/lib/research-lab/compose-basket";
import type { ResearchLabListItem, ResearchLabPayload } from "@/lib/research-lab/types";
import {
  createRetailServiceRoleClient,
  createServiceRoleClient,
  isRetailSupabaseConfigured,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import { iressPriceOverlayEnabled } from "@/lib/iress/overlay-policy";
import { loadCanonicalRetailAum } from "@/lib/aum/canonical-retail-aum";
import { isUatStrategy } from "@/lib/aum/retail-live-scope";

const bare = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

const SEC_SELECT =
  "symbol,name,sector,industry,last_price,pe,eps,dividend_yield,beta,market_cap,ytd_performance";

async function overlayIressQuotes(rows: SecurityRef[]): Promise<number> {
  // UAT (IRESS_PRICE_OVERLAY=0): IRESS quotes are test data. Keep the Yahoo-fed
  // securities_c last_price so basket valuations/weights are not computed from
  // CT test prices.
  if (!iressPriceOverlayEnabled()) {
    for (const r of rows) r.price_source = "yahoo";
    return 0;
  }
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
  investor_environment?: string | null;
  short_name?: string | null;
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
    .select("id,name,short_name,slug,investor_environment,benchmark_name,benchmark_symbol,status,holdings,min_investment")
    .order("name");
  if (error) throw error;
  const strategies = ((data ?? []) as StrategyRow[]).filter((s) => !isUatStrategy(s)).map((s) => ({
    id: s.id,
    name: s.name ?? "Strategy",
    benchmark: s.benchmark_name ?? s.benchmark_symbol ?? "—",
    holdingsCount: Array.isArray(s.holdings) ? s.holdings.length : 0,
    minInvestment: Number(s.min_investment) || 0,
    status: String(s.status ?? "—"),
  }));
  return { strategies, source: "retail-supabase" };
}

/**
 * Subset of `listResearchStrategies` filtered to strategies that hold a given
 * ticker. Used by the per-symbol Analysis tab's Research sub-tab. We fetch the
 * full `strategies_c` (it's small, ~tens of rows) and filter server-side so
 * the call shape mirrors `listResearchStrategies` — no new client contract.
 *
 * Returns `{ strategies, source, reason: "no_match" }` when no published
 * basket holds the symbol. The page renders the honest empty state for that
 * reason (different from "supabase not configured").
 */
export async function listResearchStrategiesForSymbol(sym: string): Promise<{
  strategies: ResearchLabListItem[];
  source: string;
  reason?: string;
}> {
  if (!isRetailSupabaseConfigured()) {
    return { strategies: [], source: "unavailable", reason: "supabase_not_configured" };
  }
  const retail = createRetailServiceRoleClient();
  const { data, error } = await retail
    .from("strategies_c")
    .select("id,name,short_name,slug,investor_environment,benchmark_name,benchmark_symbol,status,holdings,min_investment")
    .order("name");
  if (error) {
    return { strategies: [], source: "unavailable", reason: error.message };
  }
  const target = bare(sym);
  const strategies = ((data ?? []) as StrategyRow[])
    .filter((s) => !isUatStrategy(s))
    .filter((s) => {
      const raw = parseHoldingsJson(s.holdings);
      return raw.some((h) => bare(String(h.symbol ?? h.ticker ?? "")) === target);
    })
    .map((s) => ({
      id: s.id,
      name: s.name ?? "Strategy",
      benchmark: s.benchmark_name ?? s.benchmark_symbol ?? "—",
      holdingsCount: Array.isArray(s.holdings) ? s.holdings.length : 0,
      minInvestment: Number(s.min_investment) || 0,
      status: String(s.status ?? "—"),
    }));
  return {
    strategies,
    source: "retail-supabase",
    reason: strategies.length === 0 ? "no_match" : undefined,
  };
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
      "id,name,short_name,slug,investor_environment,sector,provider_name,benchmark_name,benchmark_symbol,status,holdings,min_investment,updated_at,description",
    )
    .eq("id", strategyId)
    .maybeSingle();

  if (error || !data || isUatStrategy(data as StrategyRow)) {
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
  const proposedHoldings = hasPending
    ? buildHoldings(raw, secMap, basketMin, { includePending: true })
    : null;

  const currentTotals = computeTotals(currentHoldings, basketMin);
  const proposedTotals = proposedHoldings ? computeTotals(proposedHoldings, basketMin) : null;

  const { metrics, gaps } = buildFundamentals(tickers, secMap);

  const canonicalAum = await loadCanonicalRetailAum(retail);
  const strategyAum = canonicalAum.byStrategy.get(strategyId);
  const investorCount = strategyAum?.users.size ?? 0;
  const aum = (strategyAum?.aumCents ?? 0) / 100;

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
