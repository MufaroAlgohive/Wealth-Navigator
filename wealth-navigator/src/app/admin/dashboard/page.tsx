"use client";

import type { Route } from "next";
import Link from "next/link";
import * as React from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";

type Row = Record<string, unknown>;
interface Counts {
  total?: number;
  public?: number;
  featured?: number;
  users?: number;
  kyc?: number;
  bank?: number;
}
interface Featured {
  id: string;
  name: string | null;
  short_name: string | null;
  sector: string | null;
  holdings: number;
  ytd: number | null;
}

const PERIODS: [string, string][] = [
  ["1D", "1d_pct"],
  ["5D", "5d_pct"],
  ["1M", "1m_pct"],
  ["6M", "6m_pct"],
  ["YTD", "ytd_pct"],
  ["1Y", "1y_pct"],
  ["5Y", "5y_pct"],
  ["All", "all_pct"],
];
const pctCls = (n: number | null) =>
  n == null ? "text-muted-foreground" : n >= 0 ? "text-success" : "text-destructive";
const pctStr = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default function DashboardPage() {
  const [counts, setCounts] = React.useState<Counts>({});
  const [featured, setFeatured] = React.useState<Featured[]>([]);
  const [assetReturns, setAssetReturns] = React.useState<Row[]>([]);
  const [strategyReturns, setStrategyReturns] = React.useState<Row[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [yahooUniverseSize, setYahooUniverseSize] = React.useState<number | null>(null);

  React.useEffect(() => {
    fetch("/api/admin/dashboard")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setCounts(d.counts || {});
          setFeatured(d.featured || []);
          setAssetReturns(d.assetReturns || []);
          setStrategyReturns(d.strategyReturns || []);
          setYahooUniverseSize(typeof d.universeSize === "number" ? d.universeSize : null);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const [mode, setMode] = React.useState<"assets" | "strategy">("assets");
  const [period, setPeriod] = React.useState("ytd_pct");
  const rows = mode === "assets" ? assetReturns : strategyReturns;
  const labelKey = mode === "assets" ? "symbol" : "name";

  const ranked = React.useMemo(() => {
    const items = rows
      .map((r) => ({ label: String(r[labelKey] ?? "—"), pct: num(r[period]) }))
      .filter((x) => x.pct != null) as { label: string; pct: number }[];
    items.sort((a, b) => b.pct - a.pct);
    return items;
  }, [rows, labelKey, period]);
  const gainers = ranked.slice(0, 10);
  // Bottom 10 by value used to be labelled "losers" unconditionally — when
  // fewer than 10 entries are actually negative, the least-positive ones
  // got shown under "Top losers" despite being genuine gains. Only a
  // negative pct is a loser.
  const losers = ranked
    .filter((x) => x.pct < 0)
    .slice(-10)
    .reverse();
  const alerts = ranked.filter((x) => x.pct <= -4);
  const maxAbs = Math.max(1, ...ranked.map((x) => Math.abs(x.pct)));

  const chartData = React.useMemo(
    () =>
      strategyReturns
        // A strategy with no YTD figure used to default to 0%, rendering as
        // a flat bar indistinguishable from a genuinely flat return. Drop
        // it instead — an absent bar is honest, a fake 0% bar is not.
        .map((r) => ({ name: String(r.name ?? "—").slice(0, 12), ytd: num(r.ytd_pct) }))
        .filter((r): r is { name: string; ytd: number } => r.ytd != null)
        .sort((a, b) => b.ytd - a.ytd)
        .slice(0, 8),
    [strategyReturns],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Total Strategies" value={loading ? "…" : String(counts.total ?? 0)} />
        <Kpi label="Featured" value={loading ? "…" : String(counts.featured ?? 0)} />
        <Kpi label="Public" value={loading ? "…" : String(counts.public ?? 0)} />
        <Kpi label="Total Users" value={loading ? "…" : String(counts.users ?? 0)} />
        <Kpi label="KYC Verified" value={loading ? "…" : String(counts.kyc ?? 0)} />
        <Kpi label="Bank Linked" value={loading ? "…" : String(counts.bank ?? 0)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Strategy chart */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-bold text-foreground">Top strategies — YTD</h2>
          {chartData.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">No strategy returns.</p>
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={90}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  />
                  <Tooltip formatter={(v: number) => `${v.toFixed(2)}%`} contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="ytd" radius={[0, 4, 4, 0]}>
                    {chartData.map((d) => (
                      <Cell
                        key={d.name}
                        fill={d.ytd >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Featured — driven by the strategy `is_featured` flag (set in the admin edit-strategy modal). */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-bold text-foreground">Featured strategies</h2>
          {featured.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              No featured strategies yet. Toggle “feature this strategy” in the edit-strategy modal.
            </p>
          ) : (
            <div className="space-y-2">
              {featured.map((f) => (
                <Link
                  key={f.id}
                  href={`/admin/factsheets?id=${f.id}` as Route}
                  className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5 hover:border-primary/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{f.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {f.sector || "—"} · {f.holdings} holdings
                    </p>
                  </div>
                  <span className={cn("text-sm font-bold", pctCls(f.ytd))}>{pctStr(f.ytd)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Strategy returns — DB-backed (certified `strategy_canonical_daily_ledger_c`
          overlay wins over guarded `strategies_returns_c`). Period pcts
          here are the same numbers the rest of the platform publishes
          (CRM, retail app, /api/strategies). The "Basket value" column
          is `client_strategy_returns_c.basket_value` (integer CENTS — see
          /api/client-book/route.ts:46) divided by 100 to render Rands. */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-foreground">Strategy returns</h2>
          <DataSourceBadge source="supabase" db="retail" />
        </div>
        {strategyReturns.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {loading
              ? "Loading strategy returns…"
              : "No strategy returns yet. Period returns populate once the returns worker runs."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-2 text-left">Strategy</th>
                  <th className="px-2 py-2 text-right">Day</th>
                  <th className="px-2 py-2 text-right">Month</th>
                  <th className="px-2 py-2 text-right">6 Month</th>
                  <th className="px-2 py-2 text-right">Basket value</th>
                </tr>
              </thead>
              <tbody>
                {strategyReturns.map((r, i) => {
                  const day = num(r["1d_pct"]);
                  const month = num(r["1m_pct"]);
                  const sixMonth = num(r["6m_pct"]);
                  // client_strategy_returns_c.basket_value is integer CENTS (see
                  // /api/client-book/route.ts:46). Divide by 100 to render Rands,
                  // otherwise the column shows ~100× too large (177,946 instead
                  // of R1,779.46 etc).
                  const basketValueCents = num(r.basket_value);
                  const basketValueRands = basketValueCents != null ? basketValueCents / 100 : null;
                  return (
                    <tr key={String(r.strategy_id ?? i)} className="border-b border-border/50 last:border-0">
                      <td className="px-2 py-2 text-left font-medium text-foreground">
                        {String(r.name ?? "—")}
                      </td>
                      <td className={cn("px-2 py-2 text-right tabular-nums font-semibold", pctCls(day))}>
                        {pctStr(day)}
                      </td>
                      <td className={cn("px-2 py-2 text-right tabular-nums font-semibold", pctCls(month))}>
                        {pctStr(month)}
                      </td>
                      <td className={cn("px-2 py-2 text-right tabular-nums font-semibold", pctCls(sixMonth))}>
                        {pctStr(sixMonth)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-foreground">
                        {basketValueRands == null
                          ? "—"
                          : basketValueRands.toLocaleString("en-ZA", {
                              style: "currency",
                              currency: "ZAR",
                              maximumFractionDigits: 2,
                            })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Return Insights — split source. The Assets mode is Yahoo-derived
          (every period pct from a single daily Yahoo history fetch per
          symbol — see /api/admin/dashboard → lib/yahoo/returns.ts), so
          the bars reflect the same prices investors see elsewhere on
          the web. The Strategies mode falls back to the certified
          Supabase ledger (same read contract the rest of the platform
          uses for store-side reporting), so only the periods the
          ledger publishes (1D / 5D / 1M / 6M / YTD) get a value —
          1Y / 5Y / All render an honest "—" on the strategies side. */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-foreground">Return Insights</h2>
            <DataSourceBadge
              source={mode === "assets" ? "yahoo" : "supabase"}
              db={mode === "strategy" ? "retail" : undefined}
            />
          </div>
          <div className="flex gap-1 rounded-lg bg-muted p-0.5">
            {(["assets", "strategy"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium capitalize",
                  mode === m ? "bg-background text-foreground shadow" : "text-muted-foreground",
                )}
              >
                {m === "assets" ? "Assets" : "Strategies"}
              </button>
            ))}
          </div>
        </div>

        <Tabs value={period} onValueChange={setPeriod}>
          <TabsList className="flex-wrap">
            {PERIODS.map(([label, key]) => (
              <TabsTrigger key={key} value={key}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={period} className="mt-4">
            {alerts.length > 0 && (
              <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground/90">
                ⚠ {alerts.length} {mode === "assets" ? "assets" : "strategies"} down ≥ 4%:{" "}
                {alerts
                  .slice(0, 6)
                  .map((a) => a.label)
                  .join(", ")}
                {alerts.length > 6 ? "…" : ""}
              </div>
            )}
            {ranked.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center">
                <p className="text-xs font-semibold text-foreground">
                  {mode === "assets"
                    ? "No Yahoo data for this period"
                    : "No strategy returns for this period"}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {loading
                    ? "Fetching full-history bars from Yahoo Finance…"
                    : mode === "assets"
                      ? `Yahoo returned no history for any of the ${yahooUniverseSize ?? 0} tracked tickers in this window.`
                      : "The certified ledger only publishes 1D / 5D / 1M / 6M / YTD for strategies — pick a closer tab."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <BarList title="Top gainers" items={gainers} maxAbs={maxAbs} positive />
                <BarList title="Top losers" items={losers} maxAbs={maxAbs} positive={false} />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function BarList({
  title,
  items,
  maxAbs,
  positive,
}: { title: string; items: { label: string; pct: number }[]; maxAbs: number; positive: boolean }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1.5">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-2">
            <span className="w-16 shrink-0 truncate text-xs text-foreground">{it.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", positive ? "bg-success" : "bg-destructive")}
                style={{ width: `${Math.min(100, (Math.abs(it.pct) / maxAbs) * 100)}%` }}
              />
            </div>
            <span className={cn("w-16 shrink-0 text-right text-xs font-semibold", pctCls(it.pct))}>
              {pctStr(it.pct)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}
