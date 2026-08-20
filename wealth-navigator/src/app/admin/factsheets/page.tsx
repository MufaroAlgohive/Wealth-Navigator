"use client";

import { ArrowLeft } from "lucide-react";
import * as React from "react";

import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { CASH_ASSET_NAME, CASH_ASSET_SYMBOL, CashAssetIcon } from "@/components/strategies/cash-asset-icon";
import { FactsheetPerformanceChart } from "@/components/strategies/factsheet-performance-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import {
  type CanonicalChartRange,
  buildCanonicalCalendarReturns,
  buildCanonicalPeriodSeries,
  canonicalDailyPnlCents,
} from "@/lib/returns/canonical-index";

interface Sec {
  symbol: string;
  name: string | null;
  logo_url: string | null;
  price_rands: number | null;
  day_pct?: number | null;
  price_as_of?: string | null;
  price_source?: string;
}
interface Holding {
  symbol?: string;
  ticker?: string;
  shares?: number;
  quantity?: number;
  weight?: number;
}
interface Strategy {
  id: string;
  name: string | null;
  short_name: string | null;
  description: string | null;
  sector: string | null;
  risk_level: string | null;
  base_currency: string | null;
  status: string | null;
  is_public: boolean | null;
  is_featured: boolean | null;
  tags: string[] | null;
  holdings: Holding[] | null;
}
interface ReturnRow {
  as_of_date: string;
  ytd_pct: number | null;
  all_pct: number | null;
  "1d_pct": number | null;
  "5d_pct": number | null;
  "1m_pct": number | null;
  mtd_pct: number | null;
  "6m_pct": number | null;
  "1y_pct": number | null;
  basket_value: number | null;
  complete_value_cents: number | null;
  continuity_cash_cents: number | null;
  securities_value_cents: number | null;
  source_kind: string | null;
}
interface ListReturns {
  latest: { ytd_pct: number | null; all_pct: number | null } | null;
  series: number[];
}
interface CashAsset {
  symbol: "CA";
  name: string;
  value: number;
  weight: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FEES = [
  "Management fee: as per strategy mandate.",
  "Execution reserve (cash): 8% of invested capital, held for slippage.",
  "Custody fee per asset applies — see App Settings.",
  "Past performance is not indicative of future results. Capital at risk.",
];

const normalize = (s: string) =>
  typeof s === "string" && s.trim() ? s.trim().split(".")[0]!.toUpperCase() : s;
/** Map a raw strategies_c.status to a display group. The DB uses values like
 *  "active" / "live" / "paper" / "halted" — "active" IS a live strategy, so
 *  hardcoding literal statuses ("staged", "draft") made every non-All filter
 *  return nothing. Anything unseen keeps its own raw value (data-driven). */
const STATUS_GROUPS: Record<string, string[]> = {
  live: ["live", "active"],
  paper: ["paper"],
  halted: ["halted"],
};
const statusGroup = (status: string | null | undefined): string => {
  const s = String(status ?? "")
    .trim()
    .toLowerCase();
  if (!s) return "unknown";
  for (const [group, members] of Object.entries(STATUS_GROUPS)) {
    if (members.includes(s)) return group;
  }
  return s;
};
const fmtR = (v: number | null, ccy = "ZAR", decimals = 0) => {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "N/A";
  try {
    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency: ccy,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  } catch {
    return `R ${n.toLocaleString()}`;
  }
};
const pctCls = (n: number | null) =>
  n == null ? "text-muted-foreground" : n >= 0 ? "text-success" : "text-destructive";
const pctStr = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
function calcMin(holdings: Holding[], secMap: Map<string, Sec>): number | null {
  let total = 0,
    matched = 0;
  for (const h of holdings) {
    const sym = String(h.ticker || h.symbol || "");
    const sec = secMap.get(sym) || secMap.get(normalize(sym));
    if (sec && sec.price_rands != null) {
      total += Number(h.shares || h.quantity || 1) * Number(sec.price_rands);
      matched++;
    }
  }
  return matched > 0 ? Math.round(total) : null;
}
function sparkPath(series: number[], w = 120, h = 32): { d: string; up: boolean } {
  if (series.length < 2) return { d: "", up: true };
  const min = Math.min(...series),
    max = Math.max(...series),
    range = max - min || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * w, h - ((v - min) / range) * h]);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`).join(" ");
  return { d, up: (series[series.length - 1] ?? 0) >= (series[0] ?? 0) };
}
function iconHue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export default function FactsheetsPage() {
  const [detailId, setDetailId] = React.useState<string | null>(null);
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setDetailId(id);
  }, []);

  return detailId ? (
    <Detail id={detailId} onBack={() => setDetailId(null)} />
  ) : (
    <Gallery onOpen={setDetailId} />
  );
}

// ───────────────────────────── Gallery ─────────────────────────────
function Gallery({ onOpen }: { onOpen: (id: string) => void }) {
  const [strategies, setStrategies] = React.useState<Strategy[] | null>(null);
  const [returns, setReturns] = React.useState<Record<string, ListReturns>>({});
  const [investors, setInvestors] = React.useState<Record<string, number>>({});
  const [filter, setFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState("recent");

  React.useEffect(() => {
    (async () => {
      const d = await fetch("/api/admin/factsheets?action=list")
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
      setStrategies(d.ok ? d.strategies || [] : []);
      setReturns(d.ok ? d.returns || {} : {});
      setInvestors(d.ok ? d.investors || {} : {});
    })();
  }, []);

  const ytdOf = (id: string) => returns[id]?.latest?.ytd_pct ?? null;
  const liveCount = (strategies ?? []).filter((s) => s.status === "live" || s.status === "active").length;
  const totalInvestors = Object.values(investors).reduce((a, b) => a + b, 0);
  const ytds = (strategies ?? []).map((s) => ytdOf(s.id)).filter((v): v is number => v != null);
  const avgYtd = ytds.length ? ytds.reduce((a, b) => a + b, 0) / ytds.length : null;
  const top = (strategies ?? []).reduce<{ name: string; ytd: number } | null>((best, s) => {
    const y = ytdOf(s.id);
    if (y == null) return best;
    return !best || y > best.ytd ? { name: s.name || "—", ytd: y } : best;
  }, null);
  const spotlight = (strategies ?? []).find((s) => s.is_featured) || (strategies ?? [])[0] || null;

  const visible = React.useMemo(() => {
    let items = [...(strategies ?? [])];
    if (filter !== "all") items = items.filter((s) => statusGroup(s.status) === filter);
    const q = search.trim().toLowerCase();
    if (q)
      items = items.filter((s) =>
        [s.name, s.short_name, s.description].filter(Boolean).join(" ").toLowerCase().includes(q),
      );
    if (sort === "name") items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    else if (sort === "ytd") items.sort((a, b) => (ytdOf(b.id) ?? -999) - (ytdOf(a.id) ?? -999));
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies, returns, filter, search, sort]);

  // Filter chips are derived from the ACTUAL statuses present in the data —
  // "live" covers DB values live|active, then paper/halted/anything else
  // appear only when the data actually contains them. This keeps the board
  // honest and every chip non-empty instead of a dead button.
  const groups = React.useMemo(() => {
    const seen = new Set<string>();
    for (const s of strategies ?? []) seen.add(statusGroup(s.status));
    return ["all", ...[...seen].sort()];
  }, [strategies]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Overview band */}
      <div className="flex justify-end">
        <DataSourceBadge source="hybrid" db="retail" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Strategies Live" value={String(liveCount)} />
        <Kpi label="Total Investors" value={String(totalInvestors)} />
        <Kpi label="Avg YTD" value={avgYtd == null ? "—" : pctStr(avgYtd)} valueCls={pctCls(avgYtd)} />
        <Kpi label="Top Performer" value={top ? top.name : "—"} sub={top ? pctStr(top.ytd) : undefined} />
      </div>

      {/* Spotlight */}
      {spotlight && (
        <button
          type="button"
          onClick={() => onOpen(spotlight.id)}
          className="block w-full rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 to-transparent p-5 text-left"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Spotlight</div>
              <div className="mt-1 text-lg font-bold text-foreground">{spotlight.name}</div>
              {spotlight.description && (
                <p className="mt-1 line-clamp-2 max-w-xl text-sm text-muted-foreground">
                  {spotlight.description}
                </p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className={cn("text-2xl font-bold", pctCls(ytdOf(spotlight.id)))}>
                {pctStr(ytdOf(spotlight.id))}
              </div>
              <div className="text-[11px] text-muted-foreground">YTD</div>
              <Spark series={returns[spotlight.id]?.series ?? []} />
            </div>
          </div>
        </button>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          {groups.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium capitalize",
                filter === f ? "bg-background text-foreground shadow" : "text-muted-foreground",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="h-8 w-40"
        />
        <div className="w-32">
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Newest</SelectItem>
              <SelectItem value="name">Name A-Z</SelectItem>
              <SelectItem value="ytd">Top YTD</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Grid */}
      {strategies === null ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No strategies.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((s) => {
            const hs = Array.isArray(s.holdings) ? s.holdings : [];
            const ytd = ytdOf(s.id);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onOpen(s.id)}
                className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[12px] font-bold text-white"
                    style={{ background: `hsl(${iconHue(s.name || "x")} 60% 50%)` }}
                  >
                    {(s.name || "S").slice(0, 2).toUpperCase()}
                  </div>
                  <div className={cn("text-right text-lg font-bold", pctCls(ytd))}>
                    {pctStr(ytd)}
                    <div className="text-[10px] font-normal text-muted-foreground">YTD</div>
                  </div>
                </div>
                <div className="mt-2 font-semibold text-foreground">{s.name}</div>
                {s.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>
                )}
                <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span>{hs.length} holdings</span>
                  <span>{investors[s.id] || 0} investors</span>
                  {s.is_featured && (
                    <span className="rounded-full bg-warning/15 px-2 text-warning">Featured</span>
                  )}
                  <span className="ml-auto capitalize">{s.status || "draft"}</span>
                </div>
                <div className="mt-2">
                  <Spark series={returns[s.id]?.series ?? []} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Detail ─────────────────────────────
function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = React.useState<{
    strategy: Strategy;
    returns: ReturnRow[];
    securities: Record<string, Sec>;
    cashAsset: CashAsset | null;
  } | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [year, setYear] = React.useState<number | null>(null);
  const [chartRange, setChartRange] = React.useState<CanonicalChartRange>("YTD");

  React.useEffect(() => {
    (async () => {
      const d = await fetch(`/api/admin/factsheets?action=detail&id=${id}`)
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
      if (d.ok) {
        setData({
          strategy: d.strategy,
          returns: d.returns || [],
          securities: d.securities || {},
          cashAsset: d.cashAsset || null,
        });
      } else setNotFound(true);
    })();
  }, [id]);

  const secMap = React.useMemo(() => {
    const m = new Map<string, Sec>();
    for (const [k, v] of Object.entries(data?.securities ?? {})) {
      m.set(k, v as Sec);
      const n = normalize(k);
      if (n !== k) m.set(n, v as Sec);
    }
    return m;
  }, [data]);

  if (notFound)
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Strategy not found.{" "}
        <button onClick={onBack} className="text-primary underline">
          Back
        </button>
      </div>
    );
  if (!data) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;

  const { strategy: s, returns } = data;
  const hs = Array.isArray(s.holdings) ? s.holdings : [];
  const tw = hs.reduce((sum, h) => sum + (Number(h.weight) || 0), 0);
  const min = calcMin(hs, secMap);
  const latest = returns[returns.length - 1] ?? null;

  // Canonical cumulative YTD is already chain-linked through rebalances.
  // Do not reconstruct the chart from basket values or legacy daily resets.
  const series = buildCanonicalPeriodSeries(returns, chartRange);
  const daily = returns
    .map((row) => row["1d_pct"])
    .filter((value): value is number => value != null && Number.isFinite(Number(value)))
    .map(Number);
  const best = daily.length ? Math.max(...daily) : null;
  const worst = daily.length ? Math.min(...daily) : null;
  const avg = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : null;

  const monthly = buildCanonicalCalendarReturns(returns);
  const years = Object.keys(monthly).sort().reverse();
  const activeYear = year ?? (years.length ? Number(years[0]) : null);

  const cashWeight = Math.max(0, Math.min(100, Number(data.cashAsset?.weight || 0)));
  const completeValueCents =
    latest?.complete_value_cents ??
    (latest ? Number(latest.securities_value_cents || 0) + Number(latest.continuity_cash_cents || 0) : null);
  const canonicalModelValue =
    completeValueCents != null && completeValueCents > 0 ? completeValueCents / 100 : min;
  const dayPnlCents = canonicalDailyPnlCents(completeValueCents, latest?.["1d_pct"]);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to factsheets
      </button>

      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{s.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {s.short_name || ""}
              {s.sector ? ` · ${s.sector}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.risk_level && <Tag>{s.risk_level}</Tag>}
              {s.status && <Tag>{s.status}</Tag>}
              {s.is_public && <Tag tone="success">Public</Tag>}
              {s.is_featured && <Tag tone="warning">Featured</Tag>}
              {(s.tags ?? []).map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
          </div>
          <DataSourceBadge source="hybrid" db="retail" />
        </div>
        {s.description && <p className="mt-4 text-sm text-foreground/80">{s.description}</p>}

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Holdings" value={String(hs.length + (data.cashAsset ? 1 : 0))} />
          <Kpi
            label="Model Basket Value"
            value={canonicalModelValue ? fmtR(canonicalModelValue, s.base_currency || "ZAR", 2) : "N/A"}
          />
          <Kpi
            label="Cash Asset (CA)"
            value={
              data.cashAsset
                ? fmtR(data.cashAsset.value, s.base_currency || "ZAR", 2)
                : fmtR(0, s.base_currency || "ZAR", 2)
            }
            valueCls="text-success"
          />
          <Kpi
            label="All-time Return"
            value={pctStr(latest?.all_pct ?? null)}
            valueCls={pctCls(latest?.all_pct ?? null)}
          />
        </div>
      </div>

      {/* Performance summary */}
      <div className="flex justify-end">
        <DataSourceBadge source="supabase" db="retail" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi
          label="1D"
          value={pctStr(latest?.["1d_pct"] ?? null)}
          valueCls={pctCls(latest?.["1d_pct"] ?? null)}
        />
        <Kpi
          label="Daily P&L / Basket"
          value={dayPnlCents == null ? "—" : fmtR(dayPnlCents / 100, s.base_currency || "ZAR", 2)}
          valueCls={pctCls(dayPnlCents)}
        />
        <Kpi
          label="5D"
          value={pctStr(latest?.["5d_pct"] ?? null)}
          valueCls={pctCls(latest?.["5d_pct"] ?? null)}
        />
        <Kpi label="MTD" value={pctStr(latest?.mtd_pct ?? null)} valueCls={pctCls(latest?.mtd_pct ?? null)} />
        <Kpi label="YTD" value={pctStr(latest?.ytd_pct ?? null)} valueCls={pctCls(latest?.ytd_pct ?? null)} />
        <Kpi
          label="All-time"
          value={pctStr(latest?.all_pct ?? null)}
          valueCls={pctCls(latest?.all_pct ?? null)}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Best Day" value={pctStr(best)} valueCls={pctCls(best)} />
        <Kpi label="Worst Day" value={pctStr(worst)} valueCls={pctCls(worst)} />
        <Kpi label="Avg Daily" value={pctStr(avg)} valueCls={pctCls(avg)} />
      </div>
      <div className="text-right text-[10px] text-muted-foreground">
        Canonical valuation as of {latest?.as_of_date || "—"} ·{" "}
        {latest?.source_kind || "effective return view"}
      </div>

      <FactsheetPerformanceChart series={series} range={chartRange} onRangeChange={setChartRange} />

      {/* Holdings */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-foreground">Portfolio Holdings</h3>
          <DataSourceBadge source="hybrid" db="retail" />
        </div>
        <div className="divide-y divide-border">
          {hs.map((h, i) => {
            const sym = String(h.ticker || h.symbol || "");
            const sec = secMap.get(sym) || secMap.get(normalize(sym));
            const price = sec?.price_rands ? Number(sec.price_rands) : 0;
            const shares = Number(h.shares || h.quantity || 1);
            const wNorm = tw > 0 ? ((Number(h.weight) || 0) / tw) * (100 - cashWeight) : 0;
            const chg = sec?.day_pct != null ? Number(sec.day_pct) : null;
            return (
              <div key={`${sym}-${i}`} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">{sym}</p>
                  <p className="truncate text-xs text-muted-foreground">{sec?.name || sym}</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {shares} sh · R {(shares * price).toFixed(2)}
                </div>
                <div className="w-16 text-right">
                  <p className="text-xs font-semibold text-primary">{wNorm.toFixed(1)}%</p>
                  {chg != null && <p className={cn("text-[11px]", pctCls(chg))}>{pctStr(chg)}</p>}
                </div>
              </div>
            );
          })}
          {data.cashAsset && data.cashAsset.value > 0 && (
            <div className="flex items-center gap-3 py-2.5">
              <CashAssetIcon className="h-9 w-9" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-success">{CASH_ASSET_SYMBOL}</p>
                <p className="text-xs text-muted-foreground">{CASH_ASSET_NAME}</p>
              </div>
              <div className="text-right text-xs text-muted-foreground">{fmtR(data.cashAsset.value)}</div>
              <div className="w-16 text-right text-xs font-semibold text-success">
                {cashWeight.toFixed(1)}%
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Calendar */}
      {years.length > 0 && activeYear != null && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-foreground">Monthly Returns</h3>
              <DataSourceBadge source="supabase" db="retail" />
            </div>
            <div className="flex gap-1">
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setYear(Number(y))}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs",
                    Number(y) === activeYear
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {y}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
            {MONTHS.map((m, i) => {
              const v = monthly[String(activeYear)]?.[i];
              return (
                <div
                  key={m}
                  className={cn(
                    "rounded-md px-1 py-2 text-center",
                    v == null ? "bg-muted/30" : v >= 0 ? "bg-success/15" : "bg-destructive/15",
                  )}
                >
                  <div className="text-[9px] uppercase text-muted-foreground">{m}</div>
                  <div
                    className={cn(
                      "text-[11px] font-semibold",
                      v == null ? "text-muted-foreground" : pctCls(v),
                    )}
                  >
                    {v == null ? "·" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fees */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="mb-2 text-sm font-bold text-foreground">Fees & Disclaimers</h3>
        <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
          {FEES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Spark({ series }: { series: number[] }) {
  if (series.length < 2) return <div className="h-8 w-[120px]" />;
  const { d, up } = sparkPath(series);
  return (
    <svg viewBox="0 0 120 32" className="h-8 w-[120px]">
      <path
        d={d}
        fill="none"
        stroke={up ? "hsl(var(--success))" : "hsl(var(--destructive))"}
        strokeWidth={1.5}
      />
    </svg>
  );
}

function Kpi({
  label,
  value,
  sub,
  valueCls,
}: { label: string; value: string; sub?: string; valueCls?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 truncate text-base font-bold text-foreground", valueCls)}>{value}</div>
      {sub && <div className={cn("text-[11px]", valueCls)}>{sub}</div>}
    </div>
  );
}
function Tag({ children, tone }: { children: React.ReactNode; tone?: "success" | "warning" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize",
        tone === "success"
          ? "bg-success/15 text-success"
          : tone === "warning"
            ? "bg-warning/15 text-warning"
            : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
