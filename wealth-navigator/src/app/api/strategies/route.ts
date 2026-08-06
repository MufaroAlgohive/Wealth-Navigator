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
import { getAdminContext } from "@/lib/admin/rbac";

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
  part: "full" | "core" | "market" = "full",
): Promise<{ strategies: Array<Record<string, unknown>>; market: Array<{ symbol: string; price: number | null; changePct: number | null }>; source: string; count: number; lastUpdatedAt: string | null }> {
  // Both stock_intraday_c reads are bounded to the last 2 days — the table
  // holds months of ticks (3.5M+ rows) and an unbounded DESC scan was
  // measured at ~7.5s on the saturated Micro tier (production-readiness
  // audit P1.9). Two days covers weekends/holidays for "latest tick".
  const sinceIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const wantCore = part !== "market";
  const wantMarket = part !== "core";
  // Stage 1 — every read here is independent; run them concurrently. The
  // previous fully-sequential chain (9 round trips) multiplied the pegged
  // DB's per-query latency into a page-blocking wait.
  const [stratRes, testProfileRows, testWalletRows, clientHoldingsRes, residualRes, strategyReturnRes] = await Promise.all([
    retail
      .from("strategies_c")
      .select(
        "id,name,slug,short_name,description,objective,risk_level,sector,base_currency,provider_name,benchmark_name,benchmark_symbol,status,is_public,is_featured,investor_environment,holdings,updated_at",
      ),
    wantCore ? retail.from("profiles").select("id").eq("is_test", true) : Promise.resolve({ data: [] as Array<{ id: string }> }),
    wantCore ? retail.from("wallets").select("user_id").eq("status", "test") : Promise.resolve({ data: [] as Array<{ user_id: string }> }),
    wantCore
      ? retail
          .from("stock_holdings_c")
          .select("user_id,family_member_id,strategy_id,security_id,quantity,avg_fill,transaction_id")
          .eq("is_active", true)
          .eq("trade_side", "BUY")
      : Promise.resolve({ data: [] }),
    wantCore
      ? retail.from("strategy_rebalance_residuals").select("user_id,family_member_id,strategy_id,balance_cents")
      : Promise.resolve({ data: [] }),
    wantCore
      ? retail
          .from("strategy_returns_effective_latest_c")
          .select('strategy_id,ytd_pct,"1d_pct",continuity_cash_cents,securities_value_cents')
      : Promise.resolve({ data: [], error: null }),
  ]);
  const { data: stratData, error: stratErr } = stratRes;
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
  // Test/UAT exclusion (both classifiers — same dual check as
  // api/investors/data.js): a single is_test-only check let internal team
  // test-wallets leak real AUM into finances.html/investors.html.
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
  const clientHoldings = clientHoldingsRes.data;
  const realHoldings = ((clientHoldings ?? []) as Array<Record<string, unknown>>).filter(
    (h) => h.user_id && h.strategy_id && !testUserIds.has(String(h.user_id)),
  );
  const holdingSecurityIds = Array.from(
    new Set(realHoldings.map((h) => String(h.security_id ?? "")).filter(Boolean)),
  );
  const holdingTxIds = Array.from(
    new Set(realHoldings.map((h) => String(h.transaction_id ?? "")).filter(Boolean)),
  );

  // Stage 2 — everything here depends only on stage 1; run concurrently.
  const [securitiesRes, liveRowsRes, txnRowsRes] = await Promise.all([
    holdingSymbols.length
      ? retail.from("securities_c").select("id,symbol,last_price,change_percent,logo_url").in("symbol", holdingSymbols)
      : Promise.resolve({ data: [] }),
    wantCore && holdingSecurityIds.length
      ? retail
          .from("stock_intraday_c")
          .select("security_id,current_price,timestamp")
          .in("security_id", holdingSecurityIds)
          .gte("timestamp", sinceIso)
          .order("timestamp", { ascending: false })
          .limit(5000)
      : Promise.resolve({ data: [] }),
    wantCore && holdingTxIds.length
      ? retail.from("transactions").select("id,buffer_cents,buffer_consumed_cents").in("id", holdingTxIds)
      : Promise.resolve({ data: [] }),
  ]);
  const securities = securitiesRes.data ?? [];

  const market: Array<{ symbol: string; price: number | null; changePct: number | null }> = [];
  const securityBySymbol = new Map<string, { symbol: string; logoUrl: string | null; priceR: number | null }>();
  {
    // Stage 3 — the ticker's intraday quotes need the securities ids.
    const securityIds = securities.map((security) => security.id).filter(Boolean);
    const { data: intraday } = wantMarket && securityIds.length
      ? await retail
          .from("stock_intraday_c")
          .select('security_id,current_price,"1d_pct",timestamp')
          .in("security_id", securityIds)
          .gte("timestamp", sinceIso)
          .order("timestamp", { ascending: false })
          .limit(5000)
      : { data: [] };
    const latest = new Map<string, Record<string, unknown>>();
    for (const quote of (intraday ?? []) as Array<Record<string, unknown>>) {
      const id = String(quote.security_id ?? "");
      if (id && !latest.has(id)) latest.set(id, quote);
    }
    for (const security of securities as Array<Record<string, unknown>>) {
      const quote = latest.get(String(security.id));
      const rawPrice = Number(quote?.current_price ?? security.last_price);
      const rawChange = Number(quote?.["1d_pct"] ?? security.change_percent);
      if (wantMarket) {
        market.push({
          symbol: String(security.symbol ?? "").replace(/\.JO$/i, ""),
          price: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice / 100 : null,
          changePct: Number.isFinite(rawChange) ? rawChange : null,
        });
      }
      const normalizedSymbol = String(security.symbol ?? "").replace(/\.JO$/i, "").toUpperCase();
      securityBySymbol.set(normalizedSymbol, { symbol: normalizedSymbol, logoUrl: security.logo_url ? String(security.logo_url) : null, priceR: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice / 100 : null });
    }
    market.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  if (part === "market") {
    return { strategies: [], market, source: "supabase", count: 0, lastUpdatedAt: new Date().toISOString() };
  }

  const livePriceCentsBySecId = new Map<string, number>();
  for (const row of (liveRowsRes.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(row.security_id ?? "");
    if (id && !livePriceCentsBySecId.has(id) && row.current_price != null) {
      livePriceCentsBySecId.set(id, Number(row.current_price));
    }
  }

  const residualByPos = new Map<string, number>();
  for (const r of (residualRes.data ?? []) as Array<Record<string, unknown>>) {
    const k = `${r.user_id}|${r.family_member_id ?? ""}|${r.strategy_id}`;
    residualByPos.set(k, (residualByPos.get(k) ?? 0) + toNumber(r.balance_cents as number));
  }

  const bufferByTxId = new Map<string, number>();
  for (const t of (txnRowsRes.data ?? []) as Array<Record<string, unknown>>) {
    bufferByTxId.set(
      String(t.id),
      toNumber(t.buffer_cents as number) - toNumber(t.buffer_consumed_cents as number),
    );
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

  // `cash` tracks ONLY the rebalance residual — the cash asset class left
  // over when a holding was liquidated (sold down/out) and hasn't been
  // redeployed into a new security yet. A basket is its securities PLUS
  // whatever cash it's currently holding from the last rebalance, so this
  // is the "cash asset class the basket holds after liquidation" figure,
  // not the pre-trade execution buffer (which is reserved, not liquidated
  // cash sitting in the basket) — deliberately excluded here.
  const agg = new Map<string, { aum: number; cash: number; users: Set<string> }>();
  for (const [, pos] of positions) {
    let bufferCents = 0;
    pos.txIds.forEach((txId) => {
      bufferCents += bufferByTxId.get(txId) ?? 0;
    });
    const a = agg.get(pos.strategyId) ?? { aum: 0, cash: 0, users: new Set<string>() };
    a.aum += pos.positionsCents + bufferCents;
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
  const cashPctByStrategy = new Map<string, number>();
  const { data: strategyReturnRows, error: strategyReturnErr } = strategyReturnRes as { data: Array<Record<string, unknown>> | null; error: unknown };
  if (!strategyReturnErr) {
    for (const r of (strategyReturnRows ?? []) as Array<Record<string, unknown>>) {
      const k = String(r["strategy_id"] ?? "");
      if (!k) continue;
      const y = r["ytd_pct"];
      if (y != null) ytdByStrategy.set(k, toNumber(y as number));
      const d1 = r["1d_pct"];
      if (d1 != null) day1PctByStrategy.set(k, toNumber(d1 as number));
      const continuityCash = toNumber(r.continuity_cash_cents as number);
      const securitiesValue = toNumber(r.securities_value_cents as number);
      const strategyValue = continuityCash + securitiesValue;
      if (continuityCash > 0 && strategyValue > 0) {
        cashPctByStrategy.set(k, (continuityCash / strategyValue) * 100);
      }
    }
  }

  const view = strategies.map((s) => {
    const a = agg.get(s.id) ?? { aum: 0, cash: 0, users: new Set<string>() };
    // basket_value / pnl are integer CENTS in retail (see /api/client-book).
    const aumR = a.aum / 100;
    // CA is the canonical model-level continuity cash weight. Never derive it
    // by summing client residuals, which duplicates the same strategy asset
    // once per investor.
    const cashPct = cashPctByStrategy.get(s.id) ?? null;
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
      // MTD P&L isn't computed from the retail aggregation — return null so
      // the UI renders "—" rather than a fake R0.00.
      pnlMtd: null,
      // The strategy's own chain-preserved YTD (guarded daily publisher) —
      // independent of which clients are currently invested, and never reset
      // by a rebalance. null only if the strategy has never published.
      ytd: ytdByStrategy.has(s.id) ? (ytdByStrategy.get(s.id) as number) : null,
      // Rebalance residual as a percentage of the canonical strategy model.
      cashWeight: cashPct,
      nav: aumR,
      investorCount: a.users.size,
      holdingsCount: (Array.isArray(s.holdings) ? (s.holdings as unknown[]).length : 0) + (cashPct != null && cashPct > 0 ? 1 : 0),
      holdingsPreview: [
        ...previewSymbols.map((symbol) => securityBySymbol.get(symbol) ?? { symbol, logoUrl: null }),
        ...(cashPct != null && cashPct > 0 ? [{ symbol: "CA", logoUrl: null, isCash: true }] : []),
      ],
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

export async function GET(req: Request) {
  // ?part=market → ticker quotes only; ?part=core → everything except the
  // ticker. Lets the strategies page render its panels and the market strip
  // from two independent requests instead of blocking the whole page on one.
  const partParam = new URL(req.url).searchParams.get("part");
  const part = partParam === "market" ? "market" : partParam === "core" ? "core" : "full";
  // UAT strategies (Test Strategy, etc.) are only for dev-tier admins to see
  // in this OEM catalogue — a routine admin has no reason to see, pick, or
  // rebalance a test strategy, and hiding it here is the one choke point
  // every consumer of this route (Rebalance Builder's picker, strategy
  // lists, etc.) inherits automatically. Default to hidden on any auth
  // failure — the safe side.
  const auth = await getAdminContext();
  const isDev = auth.status === "ok" && auth.ctx.approverTier === "dev";
  // Prefer the retail catalogue — it's the populated source (9 model
  // portfolios + live per-strategy AUM/PnL). Fall back to the institutional
  // oems_strategy_c rollup only if retail isn't configured or returns nothing.
  if (isRetailSupabaseConfigured()) {
    try {
      const retailResult = await loadRetailStrategies(createRetailServiceRoleClient(), part);
      const visibleStrategies = isDev
        ? retailResult.strategies
        : retailResult.strategies.filter((s) => s.investorEnvironment !== "UAT");
      const filteredResult = { ...retailResult, strategies: visibleStrategies, count: visibleStrategies.length };
      if (part === "market" || filteredResult.strategies.length > 0) {
        return Response.json(filteredResult);
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
