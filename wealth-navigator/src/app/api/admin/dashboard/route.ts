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

  const [allStrategies, usersCount, reqActions, stockReturns, stratReturns] = await Promise.all([
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
  const strategyReturns: Record<string, unknown>[] = latestBy(
    stratReturns as Record<string, unknown>[],
    "strategy_id",
  )
    // Drop return rows belonging to a strategy this viewer can't see, so a
    // hidden UAT strategy doesn't reappear as an unnamed line on the chart.
    .filter((r) => visibleStrategyIds.has(String(r.strategy_id)))
    .map((r) => ({
      ...r,
      name: (stratById.get(r.strategy_id as string)?.name as string) || (r.strategy_id as string),
    }));

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
