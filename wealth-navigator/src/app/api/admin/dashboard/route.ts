import { NextResponse } from "next/server";

import { canSeeUatSurfaces, getAdminContext } from "@/lib/admin/rbac";
import { toYahooSymbol } from "@/lib/data/providers/yahoo";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import { YAHOO_RETURN_PERIODS, computeYahooReturnsForUniverse } from "@/lib/yahoo/returns";

/**
 * Dashboard overview (read-only). Counts + featured strategies + Return
 * Insights data (latest per-asset and per-strategy returns).
 *
 * Two data paths inside, deliberately:
 *
 * 1) **Assets** (`assetReturns`) — Yahoo-derived (`lib/yahoo/returns.ts`).
 *    The legacy `stock_returns_c` curation table was the source of
 *    nonsense pct values for assets (Yahoo's `range=max` silently
 *    degraded to monthly granularity → 1D/5D collapsed to 0%; the first
 *    bar in some series split-adjusted down to a few cents → ALL
 *    figures like +391004%). We now derive every per-period pct from
 *    a single daily Yahoo history fetch per symbol (1D through All).
 *
 * 2) **Strategies** (`strategyReturns`) — DB-derived, exactly as it was
 *    before this refactor. The certified
 *    `strategy_canonical_daily_ledger_c` overlay is the read contract
 *    the rest of the platform (`/api/strategies`, `/api/returns/approved`,
 *    `/api/client-book`) trusts for store-side reporting — pre-cert
 *    `strategies_returns_c` is overlaid with the certified row where one
 *    exists. Switching strategies to Yahoo would lose that
 *    certification hand-off, so we leave it alone. Verified:
 *    `stock_returns_c`, `strategies_returns_c`, and the ledger overlay
 *    had no quantity / unit bugs — only the assets path needed
 *    decommissioning.
 *
 * The Overview KPIs (strategy counts, featured list, user/KYC totals)
 * still come from Supabase — those are *operational* data, not market
 * data, and were never the issue.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hard cap on Yahoo traffic per dashboard render. Sized for the union
 * of strategy holdings we expect on this deployment; tune via env if
 * the universe grows. */
const MAX_ASSET_SYMBOLS = Number.parseInt(process.env.DASHBOARD_MAX_ASSETS ?? "120", 10) || 120;

function uniqueSymbols(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const bare = String(v ?? "")
      .replace(/\.(JO|JSE)$/i, "")
      .trim()
      .toUpperCase();
    if (!bare) continue;
    if (seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}

function extractHoldingSymbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return uniqueSymbols(
    raw.map((h) => {
      if (typeof h === "string") return h;
      if (!h || typeof h !== "object") return null;
      const r = h as Record<string, unknown>;
      return String(r.ticker ?? r.symbol ?? "");
    }),
  );
}

function latestBy<T extends Record<string, unknown>>(rows: T[], key: string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = r[key] as string;
    if (k && !m.has(k)) m.set(k, r);
  }
  return [...m.values()];
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  if (!isRetailSupabaseConfigured()) {
    return NextResponse.json({
      ok: true,
      counts: {},
      featured: [],
      assetReturns: [],
      strategyReturns: [],
      notice: "RETAIL database not configured.",
      source: "unavailable",
    });
  }

  const db = createRetailServiceRoleClient();

  // Stage 1 — all operational reads run in parallel. The strategies
  // panel pulls `strategies_returns_c` + the certified canonical ledger
  // overlay here; the assets universe pulls just `securities_c` (used
  // as the ticker universe Yahoo will be queried against).
  const [allStrategies, usersCount, reqActions, holdingsPool, stratReturns, certifiedRows] =
    await Promise.all([
      db
        .from("strategies_c")
        .select(
          "id, name, short_name, sector, risk_level, base_currency, is_public, is_featured, status, holdings, investor_environment",
        )
        .then((r) => r.data ?? []),
      db
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .then((r) => r.count ?? 0),
      db
        .from("required_actions")
        .select("kyc_verified, bank_linked")
        .then((r) => r.data ?? []),
      // Markets universe — every ticker mentioned anywhere on the
      // platform shows up in `securities_c`, so this gives Return
      // Insights' assets mode the same broad coverage as the legacy
      // `stock_returns_c` curation did.
      db
        .from("securities_c")
        .select("symbol")
        .order("symbol", { ascending: true })
        .limit(2000)
        .then((r) => r.data ?? []),
      // `strategies_returns_c` — raw, pre-certification. Same "guarded
      // effective" hand-off as the rest of the app: this is the
      // baseline, the certified `strategy_canonical_daily_ledger_c`
      // overlay is authoritative where both exist.
      db
        .from("strategies_returns_c")
        .select("*")
        .order("as_of_date", { ascending: false })
        .limit(3000)
        .then((r) => r.data ?? []),
      // Certified canonical ledger — strategies_returns_c above is the
      // raw, pre-certification table (not even the guarded "effective"
      // view). For a certified strategy this can be materially stale
      // (verified: Yield Basket's raw YTD read ~16.87% against a
      // certified ~6.68% for the same date). Overlaid onto
      // strategyReturns/featured below, same "certified wins over
      // guarded" rule as /api/strategies and /api/returns/approved.
      db
        .from("strategy_canonical_daily_ledger_c")
        .select("strategy_id,as_of_date,period_metrics,complete_value_cents")
        .eq("certification_status", "CERTIFIED")
        .order("as_of_date", { ascending: false })
        .then((r) => r.data ?? []),
    ]);

  const strategies = canSeeUatSurfaces(auth.ctx)
    ? allStrategies
    : allStrategies.filter(
        (s) =>
          String(
            (s as { investor_environment?: string | null }).investor_environment ?? "LIVE",
          ).toUpperCase() !== "UAT",
      );
  const visibleStrategyIds = new Set(strategies.map((s) => String(s.id)));

  const counts = {
    total: strategies.length,
    public: strategies.filter((s) => s.is_public).length,
    featured: strategies.filter((s) => s.is_featured).length,
    users: usersCount,
    kyc: reqActions.filter((r) => r.kyc_verified).length,
    bank: reqActions.filter((r) => r.bank_linked).length,
  };

  const stratById = new Map(strategies.map((s) => [s.id, s]));

  // Build the asset universe once: union of `securities_c` and the live
  // strategy holdings. Capped at MAX_ASSET_SYMBOLS so a misconfigured
  // universe doesn't blow the per-request Yahoo budget — the cap lets
  // ops trade coverage for latency without code changes.
  const holdingSymbols = strategies.flatMap((s) =>
    extractHoldingSymbols((s as { holdings?: unknown }).holdings),
  );
  const securitySymbols = (holdingsPool as Array<{ symbol: string | null }>).map((r) =>
    r ? String(r.symbol ?? "").replace(/\.(JO|JSE)$/i, "") : "",
  );
  const universeSymbols = uniqueSymbols([...holdingSymbols, ...securitySymbols]).slice(0, MAX_ASSET_SYMBOLS);

  // Stage 2 — strategies panel (DB, cert-wins overlay).
  // Latest CERTIFIED row per strategy (certifiedRows is ordered desc,
  // so the first one seen per strategy_id is the latest). Same "5D
  // reads 1W" mapping /api/returns/approved already uses — the
  // canonical ledger doesn't publish a literal 5-trading-day figure,
  // 1W is its closest equivalent.
  const certifiedByStrategy = new Map<string, Record<string, unknown>>();
  for (const r of certifiedRows as Array<{
    strategy_id: string;
    period_metrics: Record<string, { return_pct?: number | null }> | null;
    complete_value_cents: number | null;
  }>) {
    const k = String(r.strategy_id ?? "");
    if (!k || certifiedByStrategy.has(k)) continue;
    const metrics = r.period_metrics ?? {};
    const pick = (key: string) => {
      const v = metrics[key]?.return_pct;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    certifiedByStrategy.set(k, {
      "1d_pct": pick("1D"),
      "5d_pct": pick("1W"),
      "1m_pct": pick("1M"),
      "6m_pct": pick("6M"),
      ytd_pct: pick("YTD"),
      basket_value: r.complete_value_cents ?? undefined,
    });
  }
  const strategyReturns: Record<string, unknown>[] = latestBy(
    stratReturns as Record<string, unknown>[],
    "strategy_id",
  )
    // Drop return rows belonging to a strategy this viewer can't see,
    // so a hidden UAT strategy doesn't reappear as an unnamed line on
    // the chart.
    .filter((r) => visibleStrategyIds.has(String(r.strategy_id)))
    .map((r) => {
      const certified = certifiedByStrategy.get(String(r.strategy_id)) ?? {};
      // Only overwrite fields the certified row actually has a value
      // for — undefined entries fall through to the raw
      // strategies_returns_c value.
      const merged: Record<string, unknown> = { ...r };
      for (const [key, value] of Object.entries(certified)) {
        if (value !== undefined) merged[key] = value;
      }
      return {
        ...merged,
        name: (stratById.get(r.strategy_id as string)?.name as string) || (r.strategy_id as string),
      };
    });

  // Stage 3 — assets panel (Yahoo only). Pulled in parallel (bounded)
  // so a slow symbol never starves the rest. Anything Yahoo rejects
  // (HTTP 429, unknown tickers, etc.) is dropped from the response so
  // the UI's "—" honest empty state kicks in rather than showing a
  // fake 0%.
  const assetReturnRows = universeSymbols.length
    ? await computeYahooReturnsForUniverse(universeSymbols, { concurrency: 4 })
    : [];

  const assetReturns = assetReturnRows
    .filter((r) => !r.error || typeof r["1d_pct"] === "number")
    .map((r) => {
      const bare = String(r.symbol ?? "")
        .replace(/\.(JO|JSE)$/i, "")
        .toUpperCase();
      const out: Record<string, unknown> = {
        symbol: bare,
        name: bare,
        lastPrice: r.lastPrice,
        asOf: r.asOf,
        yahooSymbol: toYahooSymbol(bare),
      };
      for (const key of YAHOO_RETURN_PERIODS) {
        out[key] = r[key] ?? null;
      }
      return out;
    });

  const featured = strategies
    .filter((s) => s.is_featured)
    .map((s) => ({
      id: s.id,
      name: s.name,
      short_name: s.short_name,
      sector: s.sector,
      holdings: Array.isArray(s.holdings) ? s.holdings.length : 0,
      ytd: (strategyReturns.find((r) => r.strategy_id === s.id)?.ytd_pct as number) ?? null,
    }));

  return NextResponse.json({
    ok: true,
    counts,
    featured,
    assetReturns,
    strategyReturns,
    source: "yahoo",
    assetSource: "yahoo",
    strategiesSource: "supabase",
    universeSize: universeSymbols.length,
  });
}
