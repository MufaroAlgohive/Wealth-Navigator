import { NextResponse } from "next/server";

import { canSeeUatSurfaces, getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Dashboard overview (read-only). Counts + featured strategies + Return
 * Insights data (latest per-asset and per-strategy returns). The legacy
 * Dashboard's Strategies/Factsheets tabs are now dedicated nav pages, so this
 * is the Overview + Return Insights only. Period pct columns are digit-prefixed
 * so we select `*` and read them by bracket key in the page.
 */

export const dynamic = "force-dynamic";

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

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({
      ok: true,
      counts: {},
      featured: [],
      assetReturns: [],
      strategyReturns: [],
      notice: "RETAIL database not configured.",
    });
  }

  const [allStrategies, usersCount, reqActions, stockReturns, stratReturns, certifiedRows] = await Promise.all([
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
    db
      .from("stock_returns_c")
      .select("*")
      .order("as_of_date", { ascending: false })
      .limit(3000)
      .then((r) => r.data ?? []),
    db
      .from("strategies_returns_c")
      .select("*")
      .order("as_of_date", { ascending: false })
      .limit(3000)
      .then((r) => r.data ?? []),
    // CERTIFIED canonical ledger — strategies_returns_c above is the raw,
    // pre-certification table (not even the guarded "effective" view). For a
    // certified strategy this can be materially stale (verified: Yield
    // Basket's raw YTD read ~16.87% against a certified ~6.68% for the same
    // date). Overlaid onto strategyReturns/featured below, same "certified
    // wins over guarded" rule as /api/strategies and /api/returns/approved.
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("strategy_id,as_of_date,period_metrics,complete_value_cents")
      .eq("certification_status", "CERTIFIED")
      .order("as_of_date", { ascending: false })
      .then((r) => r.data ?? []),
  ]);

  // Return Insights describes the real book — UAT strategies are test
  // artefacts and would otherwise inflate every count here and add their
  // deliberately-unrealistic return lines to the charts.
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
  const assetReturns = latestBy(stockReturns as Record<string, unknown>[], "symbol");

  // Latest CERTIFIED row per strategy (certifiedRows is ordered desc, so the
  // first one seen per strategy_id is the latest). Same "5D reads 1W" mapping
  // /api/returns/approved already uses — the canonical ledger doesn't publish
  // a literal 5-trading-day figure, 1W is its closest equivalent.
  const certifiedByStrategy = new Map<string, Record<string, unknown>>();
  for (const r of certifiedRows as Array<{ strategy_id: string; period_metrics: Record<string, { return_pct?: number | null }> | null; complete_value_cents: number | null }>) {
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
    // Drop return rows belonging to a strategy this viewer can't see, so a
    // hidden UAT strategy doesn't reappear as an unnamed line on the chart.
    .filter((r) => visibleStrategyIds.has(String(r.strategy_id)))
    .map((r) => {
      const certified = certifiedByStrategy.get(String(r.strategy_id)) ?? {};
      // Only overwrite fields the certified row actually has a value for —
      // undefined entries fall through to the raw strategies_returns_c value.
      const merged: Record<string, unknown> = { ...r };
      for (const [key, value] of Object.entries(certified)) {
        if (value !== undefined) merged[key] = value;
      }
      return {
        ...merged,
        name: (stratById.get(r.strategy_id as string)?.name as string) || (r.strategy_id as string),
      };
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

  return NextResponse.json({ ok: true, counts, featured, assetReturns, strategyReturns });
}
