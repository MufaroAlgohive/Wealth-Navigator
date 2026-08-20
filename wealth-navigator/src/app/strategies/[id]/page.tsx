"use client";

import {
  CASH_ASSET_COLOR,
  CASH_ASSET_NAME,
  CASH_ASSET_SYMBOL,
  CashAssetIcon,
} from "@/components/strategies/cash-asset-icon";
import { StrategyPerformanceChart } from "@/components/strategies/strategy-performance-chart";
import { cn } from "@/lib/cn";
import { formatPct, formatZAR } from "@/lib/format";
import { ArrowLeft, BarChart3, PieChart, Users } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import * as React from "react";

type Holding = {
  symbol?: string;
  ticker?: string;
  shares?: number;
  quantity?: number;
  weight?: number;
  cashValue?: number;
  isCash?: boolean;
};
type Strategy = {
  id: string;
  name: string;
  short_name?: string;
  sector?: string;
  description?: string;
  holdings?: Holding[];
  benchmark_name?: string;
};
type ReturnRow = {
  as_of_date: string;
  basket_value: number | null;
  ytd_pct: number | null;
  all_pct: number | null;
  "1d_pct": number | null;
};
type Sec = {
  symbol: string;
  name?: string;
  logo_url?: string;
  /** Rands (already cents/100 — do NOT divide again). */
  price_rands?: number | null;
  /** Percent number (e.g. -0.75 = -0.75%). */
  day_pct?: number | null;
  price_as_of?: string | null;
  price_source?: string;
};
type Investor = {
  userId: string;
  familyMemberId?: string | null;
  name: string;
  email?: string;
  computershare?: string | null;
  value: number;
  holdingsValue?: number;
  residual?: number;
  reserve?: number;
  pnl?: number;
  invested?: number;
  inceptionPct?: number | null;
  ytd: number | null;
};
type CashAsset = { symbol: "CA"; name: string; value: number; weight: number };
type Detail = {
  strategy: Strategy;
  returns: ReturnRow[];
  securities: Record<string, Sec>;
  investors: Investor[];
  cashAsset?: CashAsset | null;
};

export default function StrategyOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = React.useState<Detail | null>(null);
  React.useEffect(() => {
    void fetch(`/api/admin/factsheets?action=detail&id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((detail) => {
        if (detail.ok) setData(detail);
      });
  }, [id]);
  if (!data)
    return <div className="py-24 text-center text-sm text-muted-foreground">Loading strategy workspace…</div>;
  const s = data.strategy,
    securityHoldings = Array.isArray(s.holdings) ? s.holdings : [],
    latest = data.returns.at(-1);
  const holdings: Holding[] =
    data.cashAsset?.value && data.cashAsset.value > 0
      ? [
          ...securityHoldings,
          {
            symbol: CASH_ASSET_SYMBOL,
            weight: data.cashAsset.weight,
            cashValue: data.cashAsset.value,
            isCash: true,
          },
        ]
      : securityHoldings;
  const normalize = (value: string) => value.replace(/\.JO$/i, "").toUpperCase();
  const sec = (h: Holding) =>
    data.securities[String(h.ticker || h.symbol || "")] ||
    data.securities[`${normalize(String(h.ticker || h.symbol || ""))}.JO`] ||
    data.securities[normalize(String(h.ticker || h.symbol || ""))];
  const minValue = securityHoldings.reduce(
    (sum, h) => sum + Number(h.shares || h.quantity || 1) * Number(sec(h)?.price_rands || 0),
    0,
  );
  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-10">
      <SecurityRibbon holdings={holdings} securityFor={sec} />
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to strategies
      </button>
      <header className="glass-panel flex flex-wrap items-start gap-4 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-bold uppercase tracking-[.18em] text-primary">Strategy overview</p>
          <h1 className="mt-1 text-xl font-bold">{s.name}</h1>
          <p className="text-xs text-muted-foreground">
            {s.short_name || "MINT"}
            {s.sector ? ` · ${s.sector}` : ""}
          </p>
          {s.description && (
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-foreground/70">{s.description}</p>
          )}
        </div>
        <div className="grid grid-cols-4 divide-x divide-border overflow-hidden rounded-xl border border-border bg-background/30">
          <Kpi label="Min value" value={minValue ? formatZAR(minValue) : "—"} />
          <Kpi label="YTD" value={latest?.ytd_pct != null ? formatPct(Number(latest.ytd_pct)) : "—"} />
          <Kpi label="Holdings" value={String(holdings.length)} />
          <Kpi label="Investors" value={String(data.investors.length)} />
        </div>
      </header>
      <div className="grid grid-cols-12 gap-4">
        <section className="glass-panel col-span-12 p-4 lg:col-span-8">
          <CardTitle icon={BarChart3} title="Performance vs Benchmark" />
          <StrategyPerformanceChart rows={data.returns} height={248} />
          <div className="mt-2 flex justify-end gap-4 text-[9px] text-muted-foreground">
            <span>
              <i className="mr-1 inline-block h-2 w-2 rounded-full bg-[hsl(var(--up))]" />
              Strategy
            </span>
            <span>
              <i className="mr-1 inline-block h-0 w-3 border-t border-dashed border-muted-foreground" />
              Benchmark
            </span>
          </div>
        </section>
        <section className="glass-panel col-span-12 p-4 lg:col-span-4">
          <CardTitle icon={PieChart} title="Sector Exposure" />
          <ExposureDonut holdings={holdings} />
        </section>
        <section className="glass-panel col-span-12 overflow-hidden lg:col-span-7">
          <div className="border-b border-border px-4 py-3">
            <CardTitle icon={PieChart} title="Composition" />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_70px_110px_120px_70px] gap-3 border-b border-border bg-muted/20 px-4 py-2 text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>Instrument</span>
            <span className="text-right">Shares</span>
            <span className="text-right">Total Value (R)</span>
            <span>Weight</span>
            <span className="text-right">Day Chg</span>
          </div>
          <div className="divide-y divide-border px-4">
            {holdings.map((h, index) => {
              const security = sec(h);
              const symbol = String(h.ticker || h.symbol || "");
              const shares = h.isCash ? null : Number(h.shares || h.quantity || 1);
              // price_rands is already Rands (the API divides cents by 100).
              const price = security?.price_rands != null ? Number(security.price_rands) : null;
              const weight = holdingWeight(h, holdings);
              const change = security?.day_pct != null ? Number(security.day_pct) : null;
              return (
                <div
                  key={`${symbol}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_70px_110px_120px_70px] items-center gap-3 py-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {h.isCash ? (
                      <CashAssetIcon className="h-8 w-8" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-[8px] font-bold text-primary">
                        {security?.logo_url ? (
                          <img src={security.logo_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          normalize(symbol).slice(0, 2)
                        )}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-bold">{normalize(symbol)}</p>
                      <p className="truncate text-[9px] text-muted-foreground">
                        {h.isCash ? CASH_ASSET_NAME : security?.name || symbol}
                      </p>
                    </div>
                  </div>
                  <span className="text-right font-mono text-[10px]">{shares ?? "—"}</span>
                  <span className="text-right font-mono text-[10px] font-bold">
                    {h.isCash
                      ? formatZAR(Number(h.cashValue || 0))
                      : price == null
                        ? "—"
                        : formatZAR(Number(shares) * price)}
                  </span>
                  <div>
                    <div className="flex justify-between font-mono text-[9px]">
                      <span>{weight.toFixed(1)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, weight)}%` }}
                      />
                    </div>
                  </div>
                  <span
                    className={cn(
                      "text-right font-mono text-[10px] font-bold",
                      (change ?? 0) >= 0 ? "text-success" : "text-destructive",
                    )}
                  >
                    {h.isCash ? "—" : change == null ? "—" : formatPct(change)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="glass-panel col-span-12 overflow-hidden lg:col-span-5">
          <div className="border-b border-border px-4 py-3">
            <CardTitle icon={Users} title="Investors" />
          </div>
          <div className="divide-y divide-border px-4">
            {data.investors.length ? (
              data.investors.map((investor) => {
                const allPct = investor.inceptionPct;
                const cash = (investor.residual || 0) + (investor.reserve || 0);
                return (
                  <div key={`${investor.userId}:${investor.familyMemberId || ""}`} className="py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{investor.name}</p>
                        {(investor.email || investor.computershare) && (
                          <p className="truncate text-[9px] text-muted-foreground">
                            {investor.email}
                            {investor.computershare ? ` · ${investor.computershare}` : ""}
                          </p>
                        )}
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold",
                          (allPct ?? 0) >= 0
                            ? "bg-success/10 text-success"
                            : "bg-destructive/10 text-destructive",
                        )}
                      >
                        {allPct == null ? "—" : `${formatPct(allPct)} all-time`}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-4">
                      <div>
                        <p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
                          Invested
                        </p>
                        <p className="font-mono text-[10px] font-semibold">
                          {investor.invested != null ? formatZAR(investor.invested) : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
                          Value
                        </p>
                        <p className="font-mono text-[10px] font-bold">{formatZAR(investor.value)}</p>
                      </div>
                      <div>
                        <p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
                          P&L
                        </p>
                        <p
                          className={cn(
                            "font-mono text-[10px] font-bold",
                            (investor.pnl ?? 0) >= 0 ? "text-success" : "text-destructive",
                          )}
                        >
                          {investor.pnl != null ? formatZAR(investor.pnl) : "—"}
                        </p>
                      </div>
                      <div className="ml-auto">
                        <p className="text-right text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
                          YTD
                        </p>
                        <p
                          className={cn(
                            "text-right font-mono text-[10px] font-bold",
                            (investor.ytd ?? 0) >= 0 ? "text-success" : "text-destructive",
                          )}
                        >
                          {investor.ytd == null ? "—" : formatPct(investor.ytd)}
                        </p>
                      </div>
                    </div>
                    {cash > 0 && (
                      <p className="mt-1.5 font-mono text-[9px] text-muted-foreground">
                        Holdings {formatZAR(investor.holdingsValue || 0)} ·{" "}
                        <span className="text-cyan-600 dark:text-cyan-400">
                          Residual {formatZAR(investor.residual || 0)}
                        </span>{" "}
                        ·{" "}
                        <span className="text-violet-600 dark:text-violet-400">
                          Reserve {formatZAR(investor.reserve || 0)}
                        </span>
                      </p>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">No linked investors.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function SecurityRibbon({
  holdings,
  securityFor,
}: { holdings: Holding[]; securityFor: (holding: Holding) => Sec | undefined }) {
  const rows = holdings.map((holding) => ({ holding, security: securityFor(holding) }));
  const doubled = [...rows, ...rows];
  return (
    <div className="-mx-4 -mt-4 overflow-hidden border-y border-border bg-background/35 sm:-mx-6 sm:-mt-6">
      <div
        className="strategy-market-ticker flex w-max items-center whitespace-nowrap"
        style={{ animationDuration: `${Math.max(20, rows.length * 4)}s` }}
      >
        {doubled.map(({ holding, security }, index) => {
          const symbol = String(holding.ticker || holding.symbol || "").replace(/\.JO$/i, "");
          const price = holding.isCash
            ? Number(holding.cashValue || 0)
            : security?.price_rands != null
              ? Number(security.price_rands)
              : null;
          const change = security?.day_pct != null ? Number(security.day_pct) : null;
          return (
            <div
              key={`${symbol}-${index}`}
              className="flex h-9 items-center gap-2 border-r border-border px-5"
            >
              {holding.isCash && <CashAssetIcon className="h-5 w-5" />}
              <span className={cn("font-mono text-[10px] font-bold", holding.isCash && "text-success")}>
                {symbol}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {price != null && price > 0 ? formatZAR(price) : "—"}
              </span>
              <span
                className={cn(
                  "font-mono text-[10px] font-bold",
                  (change ?? 0) >= 0 ? "text-success" : "text-destructive",
                )}
              >
                {change == null ? "—" : change >= 0 ? "↑" : "↓"}{" "}
                {change == null ? "" : `${Math.abs(change).toFixed(2)}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function holdingWeight(holding: Holding, holdings: Holding[]) {
  const cash = holdings.find((row) => row.isCash);
  const cashWeight = Math.max(0, Math.min(100, Number(cash?.weight || 0)));
  if (holding.isCash) return cashWeight;
  const securityTotal = holdings
    .filter((row) => !row.isCash)
    .reduce((sum, row) => sum + Number(row.weight || 0), 0);
  return securityTotal > 0
    ? (Number(holding.weight || 0) / securityTotal) * (100 - cashWeight)
    : (100 - cashWeight) / Math.max(1, holdings.filter((row) => !row.isCash).length);
}
function ExposureDonut({ holdings }: { holdings: Holding[] }) {
  const palette = ["#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ec4899", "#6366f1", "#ef4444", "#84cc16"];
  const rows = holdings.map((holding, index) => ({
    symbol: String(holding.ticker || holding.symbol || "").replace(/\.JO$/i, ""),
    pct: holdingWeight(holding, holdings),
    color: holding.isCash ? CASH_ASSET_COLOR : palette[index % palette.length]!,
  }));
  let cursor = 0;
  const stops = rows
    .map((row) => {
      const start = cursor;
      cursor += row.pct;
      return `${row.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    })
    .join(", ");
  return (
    <div className="mt-4 flex items-center gap-5">
      <div
        className="relative h-36 w-36 shrink-0 rounded-full"
        style={{ background: `conic-gradient(${stops || "hsl(var(--muted)) 0 100%"})` }}
      >
        <div className="absolute inset-[23%] flex flex-col items-center justify-center rounded-full border border-border bg-card shadow-inner">
          <span className="font-mono text-lg font-bold">{holdings.length}</span>
          <span className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
            Holdings
          </span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {rows.map((row) => (
          <div key={row.symbol} className="flex items-center gap-2 text-[10px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.color }} />
            <span className="min-w-0 flex-1 truncate font-semibold">{row.symbol}</span>
            <span className="font-mono font-bold">{row.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardTitle({
  icon: Icon,
  title,
}: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <h2 className="text-xs font-bold">{title}</h2>
    </div>
  );
}
function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24 px-3 py-2 text-center">
      <p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-xs font-bold">{value}</p>
    </div>
  );
}
