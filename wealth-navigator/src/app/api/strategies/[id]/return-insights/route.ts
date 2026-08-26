import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { computePeriodReturns, computeYahooReturnsForUniverse, type YahooBar } from "@/lib/yahoo/returns";

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

function benchmarkYahooSymbol(symbol: string): string {
  return ["ALSI", "J203", "FTSE/JSE ALL SHARE"].includes(symbol) ? "^J203" : symbol;
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
  const benchmarkYahoo = benchmarkYahooSymbol(benchmark);
  const priceSymbols = uniqueSymbols.flatMap((symbol) => [symbol, `${symbol}.JO`]);

  const [assetRows, securityRes, ledgerRes, storedCloseRes] = await Promise.all([
    computeYahooReturnsForUniverse([...uniqueSymbols, ...(benchmarkYahoo ? [benchmarkYahoo] : [])], { concurrency: 3 }),
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
    priceSymbols.length
      ? db.from("stock_returns_c").select("symbol,current_price,as_of_date").in("symbol", priceSymbols).order("as_of_date")
      : Promise.resolve({ data: [], error: null }),
  ]);

  const nameBySymbol = new Map(
    ((securityRes.data ?? []) as Array<{ symbol: string; name: string | null }>).map((row) => [bare(row.symbol), row.name]),
  );
  const bySymbol = new Map(assetRows.map((row) => [bare(row.symbol), row]));
  const storedBars = new Map<string, YahooBar[]>();
  for (const row of (storedCloseRes.data ?? []) as Array<{ symbol: string; current_price: number | string | null; as_of_date: string }>) {
    const symbol = bare(row.symbol);
    const close = Number(row.current_price);
    if (!symbol || !Number.isFinite(close) || close <= 0) continue;
    const bars = storedBars.get(symbol) ?? [];
    bars.push({ t: Date.parse(`${row.as_of_date}T12:00:00Z`), close });
    storedBars.set(symbol, bars);
  }
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
    const fallback = computePeriodReturns(storedBars.get(symbol) ?? []);
    const yahooUsable = Boolean(row?.asOf && row?.["1d_pct"] != null);
    return {
      symbol,
      name: nameBySymbol.get(symbol) ?? null,
      asOf: yahooUsable ? row?.asOf ?? null : fallback.asOf ? new Date(fallback.asOf).toISOString() : null,
      source: yahooUsable ? "yahoo" : fallback.asOf ? "supabase-stored-close" : "unavailable",
      error: row?.error ?? (fallback.asOf ? null : "No usable Yahoo or stored-close history"),
      returns: {
        "1d_pct": row?.["1d_pct"] ?? fallback.period["1d_pct"] ?? null,
        "5d_pct": row?.["5d_pct"] ?? fallback.period["5d_pct"] ?? null,
        mtd_pct: row?.mtd_pct ?? fallback.period.mtd_pct ?? null,
        "6m_pct": row?.["6m_pct"] ?? fallback.period["6m_pct"] ?? null,
        ytd_pct: row?.ytd_pct ?? fallback.period.ytd_pct ?? null,
        "1y_pct": row?.["1y_pct"] ?? fallback.period["1y_pct"] ?? null,
      },
    };
  });

  const benchmarkRow = benchmarkYahoo ? bySymbol.get(bare(benchmarkYahoo)) : undefined;
  return NextResponse.json({
    ok: true,
    strategy,
    constituents,
    cash: { symbol: "CA", name: "Continuity cash", source: "cash", returns: Object.fromEntries(["1d_pct", "5d_pct", "mtd_pct", "6m_pct", "ytd_pct", "1y_pct"].map((key) => [key, 0])) },
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
