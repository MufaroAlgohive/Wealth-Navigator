import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { computeYahooReturnsForUniverse } from "@/lib/yahoo/returns";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type MetricMap = Record<string, { return_pct?: number | null }>;

function bare(value: unknown): string {
  return String(value ?? "").replace(/\.(JO|JSE)$/i, "").trim().toUpperCase();
}

function pct(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chainPeriod(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || 1 + prior / 100 === 0) return null;
  return Number((((1 + current / 100) / (1 + prior / 100) - 1) * 100).toFixed(2));
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const { id } = await context.params;
  const db = createRetailServiceRoleClient();
  const strategyRes = await db
    .from("strategies_c")
    .select("id,name,holdings,benchmark_symbol")
    .eq("id", id)
    .maybeSingle();
  if (strategyRes.error || !strategyRes.data) {
    return NextResponse.json({ ok: false, error: strategyRes.error?.message ?? "strategy not found" }, { status: 404 });
  }

  const rawHoldings = Array.isArray(strategyRes.data.holdings) ? strategyRes.data.holdings : [];
  const symbols = rawHoldings
    .map((holding) => {
      if (typeof holding === "string") return bare(holding);
      if (!holding || typeof holding !== "object") return "";
      const row = holding as Record<string, unknown>;
      return bare(row.ticker ?? row.symbol);
    })
    .filter(Boolean);
  const uniqueSymbols = [...new Set(symbols)];
  const benchmark = bare(strategyRes.data.benchmark_symbol);

  const [assetRows, securityRes, ledgerRes] = await Promise.all([
    computeYahooReturnsForUniverse([...uniqueSymbols, ...(benchmark ? [benchmark] : [])], { concurrency: 4 }),
    uniqueSymbols.length
      ? db.from("securities_c").select("symbol,name").in("symbol", uniqueSymbols)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("as_of_date,period_metrics")
      .eq("strategy_id", id)
      .eq("certification_status", "CERTIFIED")
      .order("as_of_date", { ascending: false })
      .limit(370),
  ]);

  const nameBySymbol = new Map(
    ((securityRes.data ?? []) as Array<{ symbol: string; name: string | null }>).map((row) => [bare(row.symbol), row.name]),
  );
  const bySymbol = new Map(assetRows.map((row) => [bare(row.symbol), row]));
  const latestLedger = (ledgerRes.data?.[0] ?? null) as { as_of_date: string; period_metrics: MetricMap | null } | null;
  const metrics = latestLedger?.period_metrics ?? {};
  const monthStart = latestLedger ? `${latestLedger.as_of_date.slice(0, 7)}-01` : null;
  const priorMonth = ((ledgerRes.data ?? []) as Array<{ as_of_date: string; period_metrics: MetricMap | null }>).find(
    (row) => monthStart != null && row.as_of_date < monthStart,
  );
  const currentYtd = pct(metrics.YTD?.return_pct);
  const priorYtd = pct(priorMonth?.period_metrics?.YTD?.return_pct);

  const strategy = {
    name: String(strategyRes.data.name ?? "Strategy"),
    asOf: latestLedger?.as_of_date ?? null,
    source: "certified-supabase",
    returns: {
      "1d_pct": pct(metrics["1D"]?.return_pct),
      "5d_pct": pct(metrics["1W"]?.return_pct),
      mtd_pct: chainPeriod(currentYtd, priorYtd),
      "6m_pct": pct(metrics["6M"]?.return_pct),
      ytd_pct: currentYtd,
      "1y_pct": pct(metrics["1Y"]?.return_pct),
    },
  };

  const constituents = uniqueSymbols.map((symbol) => {
    const row = bySymbol.get(symbol);
    return {
      symbol,
      name: nameBySymbol.get(symbol) ?? null,
      asOf: row?.asOf ?? null,
      source: "yahoo",
      returns: {
        "1d_pct": row?.["1d_pct"] ?? null,
        "5d_pct": row?.["5d_pct"] ?? null,
        mtd_pct: row?.mtd_pct ?? null,
        "6m_pct": row?.["6m_pct"] ?? null,
        ytd_pct: row?.ytd_pct ?? null,
        "1y_pct": row?.["1y_pct"] ?? null,
      },
    };
  });

  const benchmarkRow = benchmark ? bySymbol.get(benchmark) : undefined;
  return NextResponse.json({
    ok: true,
    strategy,
    constituents,
    cash: { symbol: "CA", name: "Continuity cash", source: "cash", returns: null },
    benchmark: benchmark
      ? {
          symbol: benchmark,
          asOf: benchmarkRow?.asOf ?? null,
          source: "yahoo",
          returns: benchmarkRow
            ? {
                "1d_pct": benchmarkRow["1d_pct"] ?? null,
                "5d_pct": benchmarkRow["5d_pct"] ?? null,
                mtd_pct: benchmarkRow.mtd_pct ?? null,
                "6m_pct": benchmarkRow["6m_pct"] ?? null,
                ytd_pct: benchmarkRow.ytd_pct ?? null,
                "1y_pct": benchmarkRow["1y_pct"] ?? null,
              }
            : null,
        }
      : null,
  });
}
