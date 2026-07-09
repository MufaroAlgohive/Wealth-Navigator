"use client";

/**
 * Phase A6 — "Overall Portfolio" tile for the OEMS Cockpit.
 *
 * Platform-wide roll-up of all MINT retail customers, sourced from the RETAIL
 * prod Supabase. The component is read-only by design — Lonwabo asked for a
 * single, clearly-labelled "what is the firm managing" panel that lets the
 * trader drill into a specific investor's per-strategy holdings + returns.
 *
 *  - Default horizon: 1D (expandable to MTD via a segmented toggle)
 *  - KPI strip: investors · holdings · total value · P&L today · P&L MTD
 *  - Investor dropdown (shadcn `Select`) — selecting one swaps the body to
 *    a per-investor view at 1D / 1M / YTD for that account.
 *  - Read endpoints: `/api/overall-portfolio` (aggregate) and
 *    `/api/overall-portfolio?investor=<id>` (per-investor drilldown). Both
 *    filter to live strategies + non-test profiles (mirrors /api/client-book).
 *
 * NOTE: P&L MTD requires an `mtd_pnl` row we currently don't have, so the
 * tile honestly shows "—" with a one-line note about the period-returns
 * worker that will populate it in the data phase. This matches the existing
 * "MTD column shows —" affordance in `cockpit-client.tsx`.
 */

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatPct, formatTime, formatZAR } from "@/lib/format";

type Horizon = "1D" | "1M" | "MTD" | "YTD";
type PerInvestorHorizon = "1D" | "1M" | "YTD";

interface AggregateResponse {
  source: "retail-supabase" | "unavailable";
  asOf: string | null;
  investors: number;
  holdings: number;
  total: number; // RANDS
  dayPnl: number; // RANDS
  mtdPnl: number | null; // RANDS — null until the period-returns worker lands
  ytdPnl: number; // RANDS
  investors_list: Array<{
    id: string;
    name: string;
    email: string | null;
    bookValue: number; // RANDS
  }>;
  reason?: string;
  error?: string;
}

interface PerInvestorResponse {
  source: "retail-supabase" | "unavailable";
  asOf: string | null;
  investor: { id: string; name: string; email: string | null } | null;
  total: number; // RANDS
  holdings: number;
  strategies: Array<{
    strategyId: string;
    strategyName: string;
    basketValue: number; // RANDS
    dayPnl: number; // RANDS
    mtdPnl: number | null;
    ytdPnl: number; // RANDS
    dayPct: number | null;
    ytdPct: number | null;
  }>;
  history: {
    days: Array<{ t: number; v: number }>;
    months: Array<{ t: number; v: number }>;
    ytd: Array<{ t: number; v: number }>;
  };
  reason?: string;
  error?: string;
}

async function fetchAggregate(): Promise<AggregateResponse> {
  const r = await fetch("/api/overall-portfolio", { cache: "no-store" });
  if (!r.ok) throw new Error(`/api/overall-portfolio ${r.status}`);
  return (await r.json()) as AggregateResponse;
}

async function fetchPerInvestor(id: string): Promise<PerInvestorResponse> {
  const r = await fetch(`/api/overall-portfolio?investor=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`/api/overall-portfolio?investor=${id} ${r.status}`);
  return (await r.json()) as PerInvestorResponse;
}

function horizonLabel(h: Horizon): string {
  return h;
}

interface OverallPortfolioProps {
  /** Where this component lives in the cockpit — controls the section title and
   *  endpoint chip the operators see when they inspect the panel. */
  endpoint: string;
  className?: string;
}

export function OverallPortfolio({ endpoint, className }: OverallPortfolioProps) {
  const realDataOnly = isRealDataOnlyClient();
  const [horizon, setHorizon] = React.useState<Horizon>("1D");
  const [selectedInvestor, setSelectedInvestor] = React.useState<string | null>(null);

  const aggregateQ = useQuery({
    queryKey: ["overall-portfolio-aggregate"],
    queryFn: fetchAggregate,
    enabled: realDataOnly,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const investors = aggregateQ.data?.investors_list ?? [];
  const aggregate = aggregateQ.data;

  // When the user picks an investor from the dropdown, fetch the per-account
  // drill-down (1D / 1M / YTD). Defaulted to "1D" per Lonwabo's spec.
  const detailQ = useQuery({
    queryKey: ["overall-portfolio-investor", selectedInvestor],
    queryFn: () => (selectedInvestor ? fetchPerInvestor(selectedInvestor) : Promise.resolve(null)),
    enabled: realDataOnly && Boolean(selectedInvestor),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Auto-pick the first investor the moment the list loads so the per-investor
  // chart isn't empty. Setting state in an effect is the safe pattern here:
  // we never read `selectedInvestor` synchronously after the assignment.
  React.useEffect(() => {
    if (selectedInvestor == null && investors.length > 0) {
      const first = investors[0];
      if (first) setSelectedInvestor(first.id);
    }
  }, [selectedInvestor, investors]);

  const aggregateSource = aggregate?.source;
  const dataSourceLabel: "supabase" | "unconfigured" | "unavailable" =
    aggregateSource === "retail-supabase"
      ? "supabase"
      : aggregateSource == null
        ? "unconfigured"
        : "unavailable";

  return (
    <GlassSection
      title="Overall Portfolio"
      subtitle={`Per-account drill-down · ${realDataOnly ? "" : "mock data"}`}
      endpoint={endpoint}
      dataSource={dataSourceLabel}
      db="retail"
      className={cn("col-span-12 flex h-[420px] flex-col min-h-0", className)}
      right={
        <div className="flex items-center gap-2">
          <span className="text-caption font-mono">horizon {horizonLabel(horizon)}</span>
        </div>
      }
    >
      {!realDataOnly ? (
        // Mock mode: show the same glass shell but flag the empty state so a
        // demo session never reads fake numbers as production truth.
        <div className="p-5">
          <EmptyDataState
            message="Overall portfolio is real-data only — enable IRESS live mode and Supabase quotes to populate."
            hint="Reads `client_strategy_returns_c` + `stock_holdings_c` from the RETAIL prod DB."
            badgeLabel="mock"
          />
        </div>
      ) : aggregateQ.isLoading ? (
        <div className="p-5">
          <p className="text-caption">Loading overall portfolio…</p>
        </div>
      ) : aggregateQ.isError || !aggregate ? (
        <div className="p-5">
          <EmptyDataState
            title="Overall portfolio unavailable"
            message="The retail client book did not return — check RETAIL_SUPABASE_URL / service role key."
          />
        </div>
      ) : aggregate.source !== "retail-supabase" ? (
        <div className="p-5">
          <EmptyDataState
            title="No retail client book"
            message={
              aggregate.reason ?? "Empty retail book — populate `client_strategy_returns_c` to surface KPIs."
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
          {/* KPI strip — investors · holdings · total · P&L today · P&L MTD.
           * P&L MTD is null until the period-returns worker lands; render
           * an honest "—" instead of fabricating a number. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <GlassKpi
              label="Investors"
              value={aggregate.investors.toLocaleString("en-ZA")}
              sub="live strategies only"
            />
            <GlassKpi
              label="Holdings"
              value={aggregate.holdings.toLocaleString("en-ZA")}
              sub="active in book"
            />
            <GlassKpi
              label="Total"
              value={formatZAR(aggregate.total)}
              sub={aggregate.asOf ? `as of ${aggregate.asOf}` : "—"}
              accent="primary"
            />
            <GlassKpi
              label={`P&L · ${horizon}`}
              value={formatZAR(aggregate.dayPnl)}
              sub={aggregate.asOf ? `book-level · ${aggregate.asOf}` : "live strategies only"}
              accent={aggregate.dayPnl >= 0 ? "positive" : "negative"}
            />
            <GlassKpi
              label="P&L · MTD"
              value={aggregate.mtdPnl == null ? "—" : formatZAR(aggregate.mtdPnl)}
              sub={aggregate.mtdPnl == null ? "period-returns worker pending" : "live strategies only"}
              accent={aggregate.mtdPnl == null ? "default" : aggregate.mtdPnl >= 0 ? "positive" : "negative"}
            />
          </div>

          {/* Investor picker + per-account drill-down. Selecting an investor
              from the dropdown swaps the bottom half to per-strategy + per-
              horizon performance for that account (1D / 1M / YTD). */}
          <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
            <div className="col-span-12 flex flex-col gap-2 sm:col-span-4">
              <p className="text-caption">Investor</p>
              <Select value={selectedInvestor ?? ""} onValueChange={(v) => setSelectedInvestor(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select investor…" />
                </SelectTrigger>
                <SelectContent>
                  {investors.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name} · {formatZAR(i.bookValue)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <InvestorList
                investors={investors}
                selectedId={selectedInvestor}
                onSelect={setSelectedInvestor}
              />
            </div>
            <div className="col-span-12 min-h-0 sm:col-span-8">
              {selectedInvestor == null ? (
                <EmptyDataState message="Pick an investor above to see 1D / 1M / YTD per-strategy performance." />
              ) : detailQ.isLoading ? (
                <p className="text-caption">Loading investor detail…</p>
              ) : detailQ.isError || !detailQ.data || detailQ.data.source !== "retail-supabase" ? (
                <EmptyDataState
                  title="No investor detail"
                  message={
                    detailQ.data?.reason ??
                    "Per-investor returns not available — populate `client_strategy_returns_c`."
                  }
                />
              ) : (
                <InvestorDetail data={detailQ.data} />
              )}
            </div>
          </div>
        </div>
      )}
    </GlassSection>
  );
}

/** Right-side investor list — small dataset so we render rows directly. */
function InvestorList({
  investors,
  selectedId,
  onSelect,
}: {
  investors: Array<{ id: string; name: string; bookValue: number }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (investors.length === 0) {
    return (
      <EmptyDataState message="No investors in book — populate `profiles` + `client_strategy_returns_c`." />
    );
  }
  return (
    <ul className="glass-inset min-h-0 max-h-72 flex-1 overflow-y-auto scrollbar-thin">
      {investors.map((i) => {
        const selected = i.id === selectedId;
        return (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => onSelect(i.id)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
                selected && "bg-primary/10",
              )}
            >
              <span className="truncate font-mono text-[11px]">{i.name}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatZAR(i.bookValue)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Per-investor drill-down — 1D / 1M / YTD horizon picker + per-strategy rows. */
function InvestorDetail({ data }: { data: PerInvestorResponse }) {
  const [horizon, setHorizon] = React.useState<PerInvestorHorizon>("1D");
  const series =
    horizon === "1D" ? data.history.days : horizon === "1M" ? data.history.months : data.history.ytd;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-caption">Per-account</p>
          <DataSourceBadge source="supabase" db="retail" />
        </div>
        <div className="glass-inset inline-flex overflow-hidden rounded-md p-0.5">
          {(["1D", "1M", "YTD"] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHorizon(h)}
              className={cn(
                "rounded px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                horizon === h ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {h}
            </button>
          ))}
        </div>
      </div>

      <div className="glass-inset grid grid-cols-3 gap-2 p-3">
        <div>
          <p className="text-caption">Total</p>
          <p className="font-mono text-lg font-semibold tabular-nums">{formatZAR(data.total)}</p>
          <p className="font-mono text-[10px] text-muted-foreground">{data.holdings} holdings</p>
        </div>
        <div>
          <p className="text-caption">P&L · {horizon}</p>
          <p
            className={cn(
              "font-mono text-lg font-semibold tabular-nums",
              horizonValue(data, horizon) >= 0 ? "text-up" : "text-down",
            )}
          >
            {formatZAR(horizonValue(data, horizon))}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {horizonPct(data, horizon) == null ? "—" : formatPct(horizonPct(data, horizon) ?? 0)}
          </p>
        </div>
        <div>
          <p className="text-caption">Strategies</p>
          <p className="font-mono text-lg font-semibold tabular-nums">{data.strategies.length}</p>
          <p className="font-mono text-[10px] text-muted-foreground">{data.asOf ?? "—"}</p>
        </div>
      </div>

      {/* Mini sparkline-ish readout — a row of stops for the horizon */}
      {(() => {
        if (series.length < 2) {
          return (
            <EmptyDataState
              message={`Not enough ${horizon} history for ${data.investor?.name ?? "this investor"} yet.`}
            />
          );
        }
        const first = series[0];
        const last = series[series.length - 1];
        if (!first || !last) {
          return (
            <EmptyDataState
              message={`Not enough ${horizon} history for ${data.investor?.name ?? "this investor"} yet.`}
            />
          );
        }
        return (
          <div className="glass-inset flex items-center gap-3 px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">from {formatTime(first.t)}</span>
            <span className="flex-1 truncate text-xs font-medium">{data.investor?.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">to {formatTime(last.t)}</span>
          </div>
        );
      })()}

      {data.strategies.length === 0 ? (
        <p className="text-caption">No live-strategy rows for this investor.</p>
      ) : (
        <div className="glass-inset flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[hsl(var(--foreground)/0.04)] backdrop-blur-sm">
              <tr className="text-caption text-left">
                <th className="px-3 py-1.5 font-medium">Strategy</th>
                <th className="px-3 py-1.5 text-right font-medium">Basket</th>
                <th className="px-3 py-1.5 text-right font-medium">1D</th>
                <th className="px-3 py-1.5 text-right font-medium">YTD</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.strategies.map((s) => (
                <tr key={s.strategyId} className="border-t border-border/60">
                  <td className="px-3 py-1.5 font-sans font-medium text-foreground">{s.strategyName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatZAR(s.basketValue)}</td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right tabular-nums",
                      s.dayPnl >= 0 ? "text-up" : "text-down",
                    )}
                  >
                    {s.dayPnl >= 0 ? "+" : ""}
                    {formatZAR(s.dayPnl)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right tabular-nums",
                      s.ytdPnl >= 0 ? "text-up" : "text-down",
                    )}
                  >
                    {s.ytdPnl >= 0 ? "+" : ""}
                    {formatZAR(s.ytdPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function horizonValue(d: PerInvestorResponse, h: PerInvestorHorizon): number {
  if (h === "1D") return d.strategies.reduce((s, x) => s + (x.dayPnl ?? 0), 0);
  return d.strategies.reduce((s, x) => s + (x.ytdPnl ?? 0), 0);
}

function horizonPct(d: PerInvestorResponse, h: PerInvestorHorizon): number | null {
  if (h === "1D") {
    if (d.total <= 0) return null;
    return (d.strategies.reduce((s, x) => s + (x.dayPnl ?? 0), 0) / d.total) * 100;
  }
  if (d.total <= 0) return null;
  return (d.strategies.reduce((s, x) => s + (x.ytdPnl ?? 0), 0) / d.total) * 100;
}
