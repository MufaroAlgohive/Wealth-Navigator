/**
 * GET /api/strategies
 *
 * DB-first read of the per-strategy rollup table `oems_strategy_c`.
 * Today the table is empty (no worker rollup yet); v1 expects a manual
 * seed or a future worker loop that aggregates `oems_position_c` per
 * `strategy_id`. The route returns an empty array with
 * `source: "unavailable"` in that case so the UI renders the honest
 * "Strategy mandates require portfolio system integration" empty state
 * instead of a fake number.
 *
 * Response shape (close to the existing seed `Strategy` view-model):
 *   {
 *     strategies: [
 *       { id, name, status, manager, benchmark, kind,
 *         aum, dayPnl, pnlMtd, ytd, cashWeight,
 *         nav, investorCount, holdingsCount, lastRebalanced,
 *         sharpe?, maxDD?, trackingError?, weightedAvgYield?, weightedAvgDuration? }
 *     ],
 *     source: "supabase" | "unavailable",
 *     reason?: string,
 *   }
 */
import {
  createServiceRoleClient,
  isSupabaseConfigured,
  createRetailServiceRoleClient,
  isRetailSupabaseConfigured,
} from "@/lib/supabase/server";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retail model-portfolio catalogue (`strategies_c`) + per-strategy AUM/PnL
 * aggregated from `client_strategy_returns_c` (latest snapshot). This is the
 * real, populated source today; the institutional `oems_strategy_c` rollup is
 * a fallback (empty until the IPS/portfolio rollup loop exists).
 */
interface RetailStrategyRow {
  id: string;
  name: string | null;
  slug: string | null;
  sector: string | null;
  provider_name: string | null;
  benchmark_name: string | null;
  benchmark_symbol: string | null;
  status: string | null;
  holdings: unknown;
  updated_at: string | null;
}

async function loadRetailStrategies(
  retail: ReturnType<typeof createRetailServiceRoleClient>,
): Promise<{ strategies: ReturnType<typeof mapRow>[]; market: Array<{ symbol: string; price: number | null; changePct: number | null }>; source: string; count: number; lastUpdatedAt: string | null }> {
  const { data: stratData, error: stratErr } = await retail
    .from("strategies_c")
    .select(
      "id,name,slug,sector,provider_name,benchmark_name,benchmark_symbol,status,holdings,updated_at",
    );
  if (stratErr) throw stratErr;
  const strategies = (stratData ?? []) as RetailStrategyRow[];
  const holdingSymbols = Array.from(new Set(strategies.flatMap((strategy) => {
    if (!Array.isArray(strategy.holdings)) return [];
    return strategy.holdings.map((holding) => {
      if (typeof holding === "string") return holding;
      if (!holding || typeof holding !== "object") return "";
      const row = holding as Record<string, unknown>;
      return String(row.ticker ?? row.symbol ?? "");
    });
  }).map((symbol) => symbol.trim()).filter(Boolean)));
  const market: Array<{ symbol: string; price: number | null; changePct: number | null }> = [];
  const securityBySymbol = new Map<string, { symbol: string; logoUrl: string | null }>();
  if (holdingSymbols.length) {
    const { data: securities } = await retail
      .from("securities_c")
      .select("id,symbol,last_price,change_percent,logo_url")
      .in("symbol", holdingSymbols);
    const securityIds = (securities ?? []).map((security) => security.id).filter(Boolean);
    const { data: intraday } = securityIds.length
      ? await retail
          .from("stock_intraday_c")
          .select('security_id,current_price,"1d_pct",timestamp')
          .in("security_id", securityIds)
          .order("timestamp", { ascending: false })
          .limit(5000)
      : { data: [] };
    const latest = new Map<string, Record<string, unknown>>();
    for (const quote of (intraday ?? []) as Array<Record<string, unknown>>) {
      const id = String(quote.security_id ?? "");
      if (id && !latest.has(id)) latest.set(id, quote);
    }
    for (const security of (securities ?? []) as Array<Record<string, unknown>>) {
      const quote = latest.get(String(security.id));
      const rawPrice = Number(quote?.current_price ?? security.last_price);
      const rawChange = Number(quote?.["1d_pct"] ?? security.change_percent);
      market.push({
        symbol: String(security.symbol ?? "").replace(/\.JO$/i, ""),
        price: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice / 100 : null,
        changePct: Number.isFinite(rawChange) ? rawChange : null,
      });
      const normalizedSymbol = String(security.symbol ?? "").replace(/\.JO$/i, "").toUpperCase();
      securityBySymbol.set(normalizedSymbol, { symbol: normalizedSymbol, logoUrl: security.logo_url ? String(security.logo_url) : null });
    }
    market.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  // Aggregate AUM / day-PnL / YTD-PnL / investors per strategy at the latest date.
  const agg = new Map<string, { aum: number; day: number; ytd: number; users: Set<string> }>();
  const { data: latestRows } = await retail
    .from("client_strategy_returns_c")
    .select("as_of_date")
    .order("as_of_date", { ascending: false })
    .limit(1);
  const asOf = (latestRows?.[0]?.as_of_date as string | undefined) ?? null;
  if (asOf) {
    const { data: rows } = await retail
      .from("client_strategy_returns_c")
      .select('strategy_id,user_id,basket_value,"1d_pnl","ytd_pnl"')
      .eq("as_of_date", asOf);
    for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
      const k = String(r["strategy_id"] ?? "");
      if (!k) continue;
      const a = agg.get(k) ?? { aum: 0, day: 0, ytd: 0, users: new Set<string>() };
      a.aum += toNumber(r["basket_value"] as number);
      a.day += toNumber(r["1d_pnl"] as number);
      a.ytd += toNumber(r["ytd_pnl"] as number);
      if (r["user_id"]) a.users.add(String(r["user_id"]));
      agg.set(k, a);
    }
  }

  const view = strategies.map((s) => {
    const a = agg.get(s.id) ?? { aum: 0, day: 0, ytd: 0, users: new Set<string>() };
    // basket_value / pnl are integer CENTS in retail (see /api/client-book).
    const aumR = a.aum / 100;
    const ytdR = a.ytd / 100;
    const cost = aumR - ytdR;
    const sector = String(s.sector ?? "").toLowerCase();
    const kind = sector.includes("money")
      ? "money_market"
      : sector.includes("fixed")
        ? "fixed_income"
        : sector.includes("balanc")
          ? "balanced"
          : "equity";
    const st = String(s.status ?? "").toLowerCase();
    const previewSymbols = Array.isArray(s.holdings) ? s.holdings.map((holding) => {
      if (typeof holding === "string") return holding;
      if (!holding || typeof holding !== "object") return "";
      const row = holding as Record<string, unknown>;
      return String(row.ticker ?? row.symbol ?? "");
    }).map((symbol) => symbol.replace(/\.JO$/i, "").toUpperCase()).filter(Boolean) : [];
    return {
      id: s.id,
      name: s.name ?? s.slug ?? "Strategy",
      status: (st === "active" || st === "live" ? "live" : "paper") as "live" | "paper" | "halted",
      kind: kind as "equity" | "money_market" | "balanced" | "fixed_income",
      manager: s.provider_name ?? "—",
      benchmark: s.benchmark_name ?? s.benchmark_symbol ?? "—",
      aum: aumR,
      dayPnl: a.day / 100,
      // MTD P&L + cash weight aren't computed from the retail aggregation —
      // return null so the UI renders "—" rather than a fake R0.00 / 0.0%.
      pnlMtd: null,
      // YTD needs a cost basis; with no subscribed capital there's nothing to
      // annualise, so null → "—" instead of an implied-flat 0.00%.
      ytd: cost > 0 ? (ytdR / cost) * 100 : null,
      cashWeight: null,
      nav: aumR,
      investorCount: a.users.size,
      holdingsCount: Array.isArray(s.holdings) ? (s.holdings as unknown[]).length : 0,
      holdingsPreview: previewSymbols.map((symbol) => securityBySymbol.get(symbol) ?? { symbol, logoUrl: null }),
      lastRebalanced: s.updated_at ? new Date(s.updated_at).toISOString().slice(0, 10) : "—",
      deployedAt: null as string | null,
      sharpe: 0,
      maxDD: 0,
      trackingError: 0,
      weightedAvgYield: 0,
      weightedAvgDuration: 0,
    };
  });
  view.sort((x, y) => y.aum - x.aum);
  return {
    strategies: view,
    market,
    source: "supabase",
    count: view.length,
    lastUpdatedAt: asOf ? new Date(asOf).toISOString() : null,
  };
}

interface StrategyRow {
  strategy_id: string;
  name: string;
  status: string;
  asset_class: string;
  manager: string | null;
  benchmark: string | null;
  aum_cents: number | string;
  pnl_today_cents: number | string;
  pnl_mtd_cents: number | string;
  pnl_ytd_pct: number | string;
  nav_value_cents: number | string;
  investor_count: number;
  holdings_count: number;
  cash_weight_pct: number | string;
  deployed_at: string | null;
  last_rebalanced_at: string | null;
  payload: Record<string, unknown>;
  ingested_at: string;
  updated_at: string;
}

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function centsToRands(v: number | string): number {
  return toNumber(v) / 100;
}

function mapRow(r: StrategyRow) {
  const payload = (r.payload ?? {}) as Record<string, unknown>;
  return {
    id: r.strategy_id,
    name: r.name,
    status: r.status as "live" | "paper" | "halted",
    kind: (r.asset_class === "money_market"
      ? "money_market"
      : r.asset_class === "fixed_income"
        ? "fixed_income"
        : r.asset_class === "balanced"
          ? "balanced"
          : "equity") as "equity" | "money_market" | "balanced" | "fixed_income",
    manager: r.manager ?? payload.manager as string ?? "—",
    benchmark: r.benchmark ?? payload.benchmark as string ?? "—",
    aum: centsToRands(r.aum_cents),
    dayPnl: centsToRands(r.pnl_today_cents),
    // Preserve a genuine "not provided" (null) as null so it shows "—";
    // only a real 0 column value renders as R0.00 / 0.0%.
    pnlMtd: r.pnl_mtd_cents == null ? null : centsToRands(r.pnl_mtd_cents),
    ytd: r.pnl_ytd_pct == null ? null : toNumber(r.pnl_ytd_pct),
    cashWeight: r.cash_weight_pct == null ? null : toNumber(r.cash_weight_pct),
    nav: centsToRands(r.nav_value_cents),
    investorCount: r.investor_count ?? 0,
    holdingsCount: r.holdings_count ?? 0,
    lastRebalanced: r.last_rebalanced_at
      ? new Date(r.last_rebalanced_at).toISOString().slice(0, 10)
      : "—",
    deployedAt: r.deployed_at,
    // Optional seed fields — these live on the seed `Strategy` view-model
    // for the mock UI. We surface a payload passthrough so future
    // schema columns don't require a BFF change.
    sharpe: typeof payload.sharpe === "number" ? (payload.sharpe as number) : 0,
    maxDD: typeof payload.maxDD === "number" ? (payload.maxDD as number) : 0,
    trackingError:
      typeof payload.trackingError === "number" ? (payload.trackingError as number) : 0,
    weightedAvgYield:
      typeof payload.weightedAvgYield === "number" ? (payload.weightedAvgYield as number) : 0,
    weightedAvgDuration:
      typeof payload.weightedAvgDuration === "number"
        ? (payload.weightedAvgDuration as number)
        : 0,
  };
}

export async function GET() {
  // Prefer the retail catalogue — it's the populated source (9 model
  // portfolios + live per-strategy AUM/PnL). Fall back to the institutional
  // oems_strategy_c rollup only if retail isn't configured or returns nothing.
  if (isRetailSupabaseConfigured()) {
    try {
      const retailResult = await loadRetailStrategies(createRetailServiceRoleClient());
      if (retailResult.strategies.length > 0) {
        return Response.json(retailResult);
      }
    } catch {
      // fall through to the institutional rollup
    }
  }

  if (!isSupabaseConfigured()) {
    return Response.json(
      {
        error: "Supabase not configured",
        strategies: [],
        source: "unavailable",
        reason: "supabase_not_configured",
      },
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("oems_strategy_c")
    .select("*")
    .order("aum_cents", { ascending: false });

  if (error) {
    const reason: BffUnavailableReason = "supabase_query_failed";
    return Response.json(
      {
        error: error.message,
        strategies: [],
        source: "unavailable",
        reason,
        migration: isSupabaseSchemaMissing(error)
          ? "supabase/migrations/20260613000002_oems_strategy_c.sql"
          : undefined,
      },
      { status: 200 },
    );
  }

  const rows = (data ?? []) as StrategyRow[];
  return Response.json({
    strategies: rows.map(mapRow),
    source: rows.length > 0 ? "supabase" : "unavailable",
    count: rows.length,
    reason: rows.length === 0 ? "empty" : undefined,
    lastUpdatedAt:
      rows.length > 0
        ? rows.reduce<string | null>((acc, r) => {
            const t = new Date(r.updated_at ?? r.ingested_at ?? 0).getTime();
            if (!Number.isFinite(t)) return acc;
            if (acc == null) return new Date(t).toISOString();
            return new Date(Math.max(new Date(acc).getTime(), t)).toISOString();
          }, null)
        : null,
  });
}
