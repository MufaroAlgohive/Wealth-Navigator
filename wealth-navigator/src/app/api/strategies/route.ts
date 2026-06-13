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
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    pnlMtd: centsToRands(r.pnl_mtd_cents),
    ytd: toNumber(r.pnl_ytd_pct),
    cashWeight: toNumber(r.cash_weight_pct),
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
