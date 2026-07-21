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
  short_name: string | null;
  description: string | null;
  objective: string | null;
  risk_level: string | null;
  base_currency: string | null;
  is_public: boolean | null;
  is_featured: boolean | null;
  investor_environment: string | null;
  holdings: unknown;
  updated_at: string | null;
}

async function loadRetailStrategies(
  retail: ReturnType<typeof createRetailServiceRoleClient>,
): Promise<{ strategies: ReturnType<typeof mapRow>[]; market: Array<{ symbol: string; price: number | null; changePct: number | null }>; source: string; count: number; lastUpdatedAt: string | null }> {
  const { data: stratData, error: stratErr } = await retail
    .from("strategies_c")
    .select(
      "id,name,slug,short_name,description,objective,risk_level,sector,base_currency,provider_name,benchmark_name,benchmark_symbol,status,is_public,is_featured,investor_environment,holdings,updated_at",
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
  const securityBySymbol = new Map<string, { symbol: string; logoUrl: string | null; priceR: number | null }>();
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
      securityBySymbol.set(normalizedSymbol, { symbol: normalizedSymbol, logoUrl: security.logo_url ? String(security.logo_url) : null, priceR: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice / 100 : null });
    }
    market.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  // Test/UAT exclusion (both classifiers — same dual check just added to
  // api/investors/data.js): a single is_test-only check let internal team
  // test-wallets leak real AUM into finances.html/investors.html.
  const [testProfileRows, testWalletRows] = await Promise.all([
    retail.from("profiles").select("id").eq("is_test", true),
    retail.from("wallets").select("user_id").eq("status", "test"),
  ]);
  const testUserIds = new Set<string>([
    ...((testProfileRows.data ?? []) as Array<{ id: string }>).map((r) => r.id),
    ...((testWalletRows.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
  ]);

  // AUM/investor count come from LIVE holdings, matching finances.html's
  // trusted investorValue methodology exactly: live holdings market value +
  // rebalance residual + held 8% execution buffer, per (user, family,
  // strategy) position. This replaced summing the return-publication views'
  // basket_value_cents, which leaked a UAT test wallet's fake balance into
  // the total (confirmed: ~R45k of an apparent ~R65k was one test account).
  const { data: clientHoldings } = await retail
    .from("stock_holdings_c")
    .select("user_id,family_member_id,strategy_id,security_id,quantity,avg_fill,transaction_id")
    .eq("is_active", true)
    .eq("trade_side", "BUY");
  const realHoldings = ((clientHoldings ?? []) as Array<Record<string, unknown>>).filter(
    (h) => h.user_id && h.strategy_id && !testUserIds.has(String(h.user_id)),
  );

  const holdingSecurityIds = Array.from(
    new Set(realHoldings.map((h) => String(h.security_id ?? "")).filter(Boolean)),
  );
  const livePriceCentsBySecId = new Map<string, number>();
  if (holdingSecurityIds.length) {
    const { data: liveRows } = await retail
      .from("stock_intraday_c")
      .select("security_id,current_price,timestamp")
      .in("security_id", holdingSecurityIds)
      .order("timestamp", { ascending: false })
      .limit(5000);
    for (const row of (liveRows ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.security_id ?? "");
      if (id && !livePriceCentsBySecId.has(id) && row.current_price != null) {
        livePriceCentsBySecId.set(id, Number(row.current_price));
      }
    }
  }

  const { data: residualRows } = await retail
    .from("strategy_rebalance_residuals")
    .select("user_id,family_member_id,strategy_id,balance_cents");
  const residualByPos = new Map<string, number>();
  for (const r of (residualRows ?? []) as Array<Record<string, unknown>>) {
    const k = `${r.user_id}|${r.family_member_id ?? ""}|${r.strategy_id}`;
    residualByPos.set(k, (residualByPos.get(k) ?? 0) + toNumber(r.balance_cents as number));
  }

  const holdingTxIds = Array.from(
    new Set(realHoldings.map((h) => String(h.transaction_id ?? "")).filter(Boolean)),
  );
  const bufferByTxId = new Map<string, number>();
  if (holdingTxIds.length) {
    const { data: txnRows } = await retail
      .from("transactions")
      .select("id,buffer_cents,buffer_consumed_cents")
      .in("id", holdingTxIds);
    for (const t of (txnRows ?? []) as Array<Record<string, unknown>>) {
      bufferByTxId.set(
        String(t.id),
        toNumber(t.buffer_cents as number) - toNumber(t.buffer_consumed_cents as number),
      );
    }
  }

  // Group into positions first (mirrors aumFeeEngine.buildPositions), then
  // aggregate per strategy — a position's buffer/residual must only count
  // once even though it may span several holding rows.
  const positions = new Map<
    string,
    { strategyId: string; userId: string; positionsCents: number; txIds: Set<string> }
  >();
  for (const h of realHoldings) {
    const strategyId = String(h.strategy_id ?? "");
    const userId = String(h.user_id ?? "");
    if (!strategyId || !userId) continue;
    const famKey = h.family_member_id ? String(h.family_member_id) : "";
    const posKey = `${userId}|${famKey}|${strategyId}`;
    const qty = Math.abs(toNumber(h.quantity as number));
    const secId = String(h.security_id ?? "");
    const priceCents = livePriceCentsBySecId.get(secId);
    const avgFillCents = toNumber(h.avg_fill as number);
    const mvCents =
      priceCents != null && priceCents > 0 ? Math.round(priceCents * qty) : Math.round(avgFillCents * qty);
    const pos = positions.get(posKey) ?? { strategyId, userId, positionsCents: 0, txIds: new Set<string>() };
    pos.positionsCents += mvCents;
    const txId = h.transaction_id ? String(h.transaction_id) : "";
    if (txId) pos.txIds.add(txId);
    positions.set(posKey, pos);
  }

  // `cash` tracks the strategy's uninvested sleeve (execution buffer +
  // rebalance residual) separately from `aum` — same underlying cents, just
  // also kept as its own running total so the UI can show "how much of this
  // strategy's AUM is sitting in cash right now" (e.g. Yield holds a real
  // cash position between rebalances) without re-deriving it from AUM.
  const agg = new Map<string, { aum: number; cash: number; users: Set<string> }>();
  for (const [, pos] of positions) {
    let bufferCents = 0;
    pos.txIds.forEach((txId) => {
      bufferCents += bufferByTxId.get(txId) ?? 0;
    });
    const a = agg.get(pos.strategyId) ?? { aum: 0, cash: 0, users: new Set<string>() };
    a.aum += pos.positionsCents + bufferCents;
    a.cash += bufferCents;
    a.users.add(pos.userId);
    agg.set(pos.strategyId, a);
  }
  // Second pass adds residual cash once per position (positions map de-dupes
  // by user+family+strategy already, so this is safe to add directly here).
  for (const [posKey, pos] of positions) {
    const residualCents = residualByPos.get(posKey) ?? 0;
    if (!residualCents) continue;
    const a = agg.get(pos.strategyId);
    if (a) {
      a.aum += residualCents;
      a.cash += residualCents;
    }
  }
  // Strategy-level YTD and Day P&L% are the model's own chain-preserved
  // return (from the guarded daily publisher) — NOT derived from an
  // aggregate client cost basis. A rebalance never resets YTD; it is the
  // same number the CRM and the retail app show for the strategy. Day P&L
  // (Rand) below = corrected AUM × the strategy's own daily chain 1d_pct.
  const ytdByStrategy = new Map<string, number>();
  const day1PctByStrategy = new Map<string, number>();
  const { data: strategyReturnRows, error: strategyReturnErr } = await retail
    .from("strategy_returns_effective_latest_c")
    .select('strategy_id,ytd_pct,"1d_pct"');
  if (!strategyReturnErr) {
    for (const r of (strategyReturnRows ?? []) as Array<Record<string, unknown>>) {
      const k = String(r["strategy_id"] ?? "");
      if (!k) continue;
      const y = r["ytd_pct"];
      if (y != null) ytdByStrategy.set(k, toNumber(y as number));
      const d1 = r["1d_pct"];
      if (d1 != null) day1PctByStrategy.set(k, toNumber(d1 as number));
    }
  }

  const view = strategies.map((s) => {
    const a = agg.get(s.id) ?? { aum: 0, cash: 0, users: new Set<string>() };
    // basket_value / pnl are integer CENTS in retail (see /api/client-book).
    const aumR = a.aum / 100;
    const cashR = a.cash / 100;
    const day1Pct = day1PctByStrategy.get(s.id) ?? null;
    const dayPnlR = day1Pct != null ? aumR * (day1Pct / 100) : 0;
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
    const minValue = Array.isArray(s.holdings) ? s.holdings.reduce((total, holding) => {
      const row = typeof holding === "object" && holding ? holding as Record<string, unknown> : {};
      const symbol = String(typeof holding === "string" ? holding : row.ticker ?? row.symbol ?? "").replace(/\.JO$/i, "").toUpperCase();
      const units = Number(row.shares ?? row.quantity ?? row.units ?? 1);
      const price = securityBySymbol.get(symbol)?.priceR;
      return total + (price != null && Number.isFinite(units) ? price * units : 0);
    }, 0) : 0;
    return {
      id: s.id,
      name: s.name ?? s.slug ?? "Strategy",
      shortName: s.short_name,
      description: s.description ?? s.objective,
      riskLevel: s.risk_level,
      sector: s.sector,
      baseCurrency: s.base_currency ?? "ZAR",
      isPublic: Boolean(s.is_public),
      isFeatured: Boolean(s.is_featured),
      investorEnvironment: String(s.investor_environment || "LIVE").toUpperCase() === "UAT" ? "UAT" : "LIVE",
      status: (st === "active" || st === "live" ? "live" : "paper") as "live" | "paper" | "halted",
      kind: kind as "equity" | "money_market" | "balanced" | "fixed_income",
      manager: s.provider_name ?? "—",
      benchmark: s.benchmark_name ?? s.benchmark_symbol ?? "—",
      aum: aumR,
      dayPnl: dayPnlR,
      // Live cash sleeve (execution buffer + rebalance residual) held by
      // this strategy's real positions right now — e.g. Yield genuinely
      // sits on cash between rebalances. Same underlying cents as the
      // portion of `aum` that isn't in securities, exposed separately.
      cash: cashR,
      // MTD P&L + cash weight aren't computed from the retail aggregation —
      // return null so the UI renders "—" rather than a fake R0.00 / 0.0%.
      pnlMtd: null,
      // The strategy's own chain-preserved YTD (guarded daily publisher) —
      // independent of which clients are currently invested, and never reset
      // by a rebalance. null only if the strategy has never published.
      ytd: ytdByStrategy.has(s.id) ? (ytdByStrategy.get(s.id) as number) : null,
      cashWeight: null,
      nav: aumR,
      investorCount: a.users.size,
      holdingsCount: Array.isArray(s.holdings) ? (s.holdings as unknown[]).length : 0,
      holdingsPreview: previewSymbols.map((symbol) => securityBySymbol.get(symbol) ?? { symbol, logoUrl: null }),
      minValue,
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
    // AUM is now computed live (holdings × live price + sleeve), not from a
    // per-owner publication date — "now" is the honest freshness marker.
    lastUpdatedAt: view.length > 0 ? new Date().toISOString() : null,
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
