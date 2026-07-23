"use client";

/**
 * Standalone Analysis price chart — close history for ANY ticker
 * (MSFT, AAPL, CPI.JO, …) with a range selector and period return + CAGR.
 * A richer take on fiscal.ai's 5y price chart. Real closes or honest empty.
 */

import { useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { TrendingDown, TrendingUp } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface ChartResp {
  ok: boolean;
  symbol: string;
  currency: string;
  range: string;
  points: Array<{ t: number; c: number }>;
  firstClose: number | null;
  lastClose: number | null;
  changePct: number | null;
  cagrPct: number | null;
  /** Which feed actually served this series (IRESS-PROD first for JSE, else Yahoo). */
  source?: "iress" | "yahoo";
  error?: string;
}

const RANGES = ["1D", "1W", "1M", "6M", "YTD", "1Y", "3Y", "5Y", "MAX"] as const;
type Range = (typeof RANGES)[number];

function ccySym(code: string): string {
  switch (code?.toUpperCase()) {
    case "USD": return "$";
    case "ZAR":
    case "ZAC": return "R";
    case "GBP":
    case "GBX": return "£";
    case "EUR": return "€";
    case "JPY": return "¥";
    default: return code ? `${code} ` : "";
  }
}

export function CompanyPriceChart({ sym }: { sym: string }) {
  const [range, setRange] = useState<Range>("5Y");
  const q = useQuery<ChartResp>({
    queryKey: ["company-chart", sym, range],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/chart?range=${range}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`chart ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });

  const d = q.data;
  const up = (d?.changePct ?? 0) >= 0;
  const stroke = up ? "hsl(var(--up))" : "hsl(var(--down))";
  const sym$ = ccySym(d?.currency ?? "USD");
  // IRESS-PROD first for JSE daily/monthly ranges; Yahoo for intraday / non-JSE
  // / fallback. Badge the source the route actually served (route sets `source`).
  const chartSource = d?.source === "iress" ? "iress" : "yahoo";
  const chartSourceLabel = chartSource === "iress" ? "IRESS·PROD" : "Market data";

  const rangeBtns = (
    <div className="glass-inset inline-flex gap-0.5 p-1">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => setRange(r)}
          className={cn(
            "h-6 rounded-md px-2 font-mono text-[10px] font-medium transition-all duration-200",
            range === r
              ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );

  return (
    <GlassSection
      title="Price history"
      subtitle={`${chartSourceLabel} · ${range} closes`}
      endpoint="GET /api/company-analysis/:sym/chart"
      dataSource={chartSource}
      noPadding
      right={rangeBtns}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* Return summary */}
        {d?.ok && d.lastClose != null ? (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Last close</span>
              <span className="font-mono text-2xl font-semibold tabular-nums">
                {sym$}
                {d.lastClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{range} return</span>
              <span className={cn("inline-flex items-center gap-1 font-mono text-lg font-semibold tabular-nums", up ? "text-up" : "text-down")}>
                {up ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                {d.changePct != null ? `${d.changePct >= 0 ? "+" : ""}${d.changePct.toFixed(1)}%` : "—"}
              </span>
            </div>
            {d.cagrPct != null ? (
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">CAGR</span>
                <span className="font-mono text-lg font-semibold tabular-nums">
                  {d.cagrPct >= 0 ? "+" : ""}
                  {d.cagrPct.toFixed(1)}%
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="glass-inset min-h-[320px] flex-1 p-2">
          {q.isLoading ? (
            <PanelSkeleton rows={5} height="h-[300px]" />
          ) : !d?.ok || d.points.length < 2 ? (
            <EmptyDataState
              reason="empty"
              message={`No price history for ${sym}.`}
              hint={d?.error ?? "The market data source returned no closes for this symbol/range."}
              badgeLabel="unconfigured"
            />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={d.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={`px-${sym}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(t: number) => {
                    const dt = new Date(t);
                    if (range === "1D") return dt.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false });
                    if (range === "1W") return dt.toLocaleDateString("en-ZA", { weekday: "short" });
                    return dt.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" });
                  }}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  axisLine={{ stroke: "hsl(var(--glass-border))" }}
                  tickLine={false}
                  minTickGap={48}
                />
                <YAxis
                  dataKey="c"
                  domain={["auto", "auto"]}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  tickFormatter={(v: number) => `${sym$}${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                />
                <RTooltip
                  contentStyle={{
                    background: "hsl(var(--popover, var(--background)))",
                    border: "1px solid hsl(var(--glass-border))",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  labelFormatter={(t: number) =>
                    range === "1D" || range === "1W"
                      ? new Date(t).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
                      : new Date(t).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })
                  }
                  formatter={(v: number) => [`${sym$}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, "Price"]}
                />
                <Area
                  dataKey="c"
                  type="monotone"
                  stroke={stroke}
                  strokeWidth={2}
                  fill={`url(#px-${sym})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </GlassSection>
  );
}
