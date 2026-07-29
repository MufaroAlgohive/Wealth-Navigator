"use client";

/**
 * Compact node bodies for the Canvas board.
 * Real live data + provenance only — never synthetic series, invented metrics, or fake headlines.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Sparkles, TrendingDown, TrendingUp } from "lucide-react";

import { DataSourceBadge, type DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import type { AnalysisMetric, CompanyAnalysis } from "@/lib/company-analysis/yahoo";
import { computeMomentum, computeRsi } from "@/lib/canvas/indicators";
import type { AiResearchResponse } from "@/lib/research-ai/provider";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

const RANGES = ["1M", "6M", "YTD", "1Y", "3Y", "5Y", "MAX"] as const;
type Range = (typeof RANGES)[number];

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
  source?: "iress" | "yahoo";
  error?: string;
}

function chartSourceKind(d: ChartResp | undefined): DataSourceKind {
  if (!d?.ok || !d.points?.length) return "unavailable";
  return d.source === "iress" ? "iress" : "yahoo";
}

function ccySym(code: string): string {
  switch (code?.toUpperCase()) {
    case "USD":
      return "$";
    case "ZAR":
    case "ZAC":
      return "R";
    case "GBP":
    case "GBX":
      return "£";
    case "EUR":
      return "€";
    case "JPY":
      return "¥";
    default:
      return code ? `${code} ` : "";
  }
}

function abbrev(v: number, dp = 2): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(dp)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(dp)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtMetric(m: AnalysisMetric | undefined, currency: string): string {
  if (!m || m.value == null || !Number.isFinite(m.value)) return "—";
  const v = m.value;
  const sym = ccySym(currency);
  switch (m.fmt) {
    case "pct":
      return `${(v * 100).toFixed(1)}%`;
    case "pct100":
      return `${v.toFixed(1)}%`;
    case "x":
      return `${v.toFixed(1)}x`;
    case "ratio":
      return v.toFixed(2);
    case "money":
      return `${sym}${abbrev(v)}`;
    case "int":
      return abbrev(v, 2);
    case "price":
      return `${sym}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    default:
      return String(v);
  }
}

function callTone(call: string): "success" | "neutral" | "destructive" {
  if (call === "bullish") return "success";
  if (call === "bearish") return "destructive";
  return "neutral";
}

function SourceRow({ source, note }: { source: DataSourceKind; note?: string }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <DataSourceBadge source={source} />
      {note ? <span className="truncate text-[9.5px] text-muted-foreground/70">{note}</span> : null}
    </div>
  );
}

// ── Chart ─────────────────────────────────────────────────────────────

export function CanvasChartNode({ sym }: { sym: string }) {
  const [range, setRange] = useState<Range>("5Y");
  const q = useQuery<ChartResp>({
    queryKey: ["company-chart", sym, range],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/chart?range=${range}`, {
        cache: "no-store",
      });
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
  const source = chartSourceKind(d);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3.5">
      <SourceRow source={q.isLoading ? "unconfigured" : source} note="GET …/chart" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          {d?.ok && d.lastClose != null ? (
            <>
              <span className="font-mono text-lg font-semibold tabular-nums tracking-tight">
                {sym$}
                {d.lastClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 font-mono text-xs font-medium tabular-nums",
                  up ? "text-up" : "text-down",
                )}
              >
                {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {d.changePct != null ? `${d.changePct >= 0 ? "+" : ""}${d.changePct.toFixed(1)}%` : "—"}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">{range}</span>
          )}
        </div>
        <div className="inline-flex gap-0.5 rounded-lg bg-[hsl(var(--foreground)/0.04)] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "h-6 rounded-md px-1.5 font-mono text-[10px] font-medium transition-colors duration-150",
                range === r
                  ? "bg-[hsl(var(--foreground)/0.1)] text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {q.isLoading ? (
          <PanelSkeleton rows={4} height="h-[220px]" />
        ) : !d?.ok || d.points.length < 2 ? (
          <EmptyDataState
            reason="empty"
            message={`No price history for ${sym}.`}
            hint={d?.error ?? "Market data returned no closes for this symbol/range."}
            badgeLabel="unavailable"
          />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={d.points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`canvas-px-${sym}-${range}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t: number) =>
                  new Date(t).toLocaleDateString("en-ZA", { month: "short", year: "2-digit" })
                }
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                dataKey="c"
                domain={["auto", "auto"]}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                width={44}
                tickFormatter={(v: number) => `${sym$}${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
              />
              <RTooltip
                contentStyle={{
                  background: "hsl(var(--popover, var(--background)))",
                  border: "1px solid hsl(var(--glass-border))",
                  borderRadius: 10,
                  fontSize: 11,
                }}
                labelFormatter={(t: number) =>
                  new Date(t).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })
                }
                formatter={(v: number) => [
                  `${sym$}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  "Close",
                ]}
              />
              <Area
                dataKey="c"
                type="monotone"
                stroke={stroke}
                strokeWidth={1.75}
                fill={`url(#canvas-px-${sym}-${range})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Fundamentals ──────────────────────────────────────────────────────

const KEY_METRICS: Array<{ group: string; key: string; label: string }> = [
  { group: "Profile", key: "Market Cap", label: "Mkt cap" },
  { group: "Valuation (TTM)", key: "P/E", label: "P/E" },
  { group: "Margins", key: "Gross", label: "Gross mgn" },
  { group: "Returns", key: "ROE", label: "ROE" },
  { group: "Growth (CAGR)", key: "Rev 3Yr", label: "Rev 3Y" },
  { group: "Dividends", key: "Yield", label: "Yield" },
];

export function CanvasFundamentalsNode({ sym }: { sym: string }) {
  const q = useQuery<CompanyAnalysis>({
    queryKey: ["company-analysis", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`company-analysis ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2 p-3.5">
        <SourceRow source="unconfigured" note="loading…" />
        <PanelSkeleton rows={5} />
      </div>
    );
  }

  const d = q.data;
  if (!d || !d.ok) {
    return (
      <div className="p-3.5">
        <EmptyDataState
          reason="empty"
          message={`No fundamentals for ${sym}.`}
          hint={d?.error ?? "Company-analysis returned no profile. Metrics show — when missing."}
          badgeLabel="yahoo"
        />
      </div>
    );
  }

  const o = d.overview;
  const ccy = d.currency;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3.5">
      <SourceRow source="yahoo" note="GET /api/company-analysis" />
      <div className="min-w-0 space-y-1">
        <p className="truncate text-[13px] font-semibold leading-tight">{o.name ?? d.symbol}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {[o.sector, o.industry].filter(Boolean).join(" · ") || "—"}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {KEY_METRICS.map(({ group, key, label }) => {
          const m = d.groups[group]?.[key];
          return (
            <div
              key={`${group}:${key}`}
              className="rounded-lg bg-[hsl(var(--foreground)/0.03)] px-2.5 py-2"
            >
              <p className="text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-0.5 font-mono text-[12.5px] font-semibold tabular-nums">{fmtMetric(m, ccy)}</p>
            </div>
          );
        })}
      </div>

      {o.ceo ? (
        <p className="mt-auto text-[11px] text-muted-foreground">
          CEO <span className="text-foreground/80">{o.ceo}</span>
          {o.employees != null ? (
            <span className="text-muted-foreground/70">
              {" "}
              · {o.employees.toLocaleString("en-US")} employees
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

// ── AI thesis ─────────────────────────────────────────────────────────

export function CanvasThesisNode({ sym }: { sym: string }) {
  const q = useQuery<AiResearchResponse>({
    queryKey: ["ai-edge", sym, 0],
    queryFn: async () => {
      const r = await fetch(`/api/research-ai?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`research-ai ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const d = q.data;
  const outlook = d?.outlook ?? null;
  const provider = (d?.provider ?? "").toLowerCase();
  const thesisSource: DataSourceKind =
    d?.configured === false ? "unconfigured" : outlook ? "external" : "unavailable";

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3.5">
        <SourceRow source="unconfigured" note="GET /api/research-ai" />
        <p className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" />
          Synthesizing thesis…
        </p>
        <PanelSkeleton rows={4} />
      </div>
    );
  }

  if (!outlook) {
    return (
      <div className="p-3.5">
        <EmptyDataState
          reason="empty"
          message={d?.configured === false ? "AI provider not configured." : `No thesis for ${sym}.`}
          hint={
            d?.configured === false
              ? "Evidence nodes still work; thesis is deferred until MiniMax is configured."
              : (d?.error ?? "Try Refresh thesis below.")
          }
          badgeLabel="unconfigured"
        />
      </div>
    );
  }

  const horizons = [
    { id: "short", label: "0–3m", h: outlook.shortTerm },
    { id: "medium", label: "3–12m", h: outlook.mediumTerm },
    { id: "long", label: "1–3y", h: outlook.longTerm },
  ] as const;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3.5">
      <SourceRow
        source={thesisSource}
        note={provider.includes("minimax") ? "MiniMax via research-ai" : d?.provider ?? "research-ai"}
      />
      <p className="line-clamp-3 text-[12.5px] leading-relaxed text-foreground/90">{outlook.summary}</p>

      <div className="grid grid-cols-3 gap-2">
        {horizons.map(({ id, label, h }) => (
          <div
            key={id}
            className="flex flex-col gap-1.5 rounded-lg bg-[hsl(var(--foreground)/0.03)] px-2.5 py-2.5"
          >
            <span className="text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
            <Pill tone={callTone(h.call)} size="xs">
              {h.call === "bullish" ? (
                <TrendingUp className="h-2.5 w-2.5" />
              ) : h.call === "bearish" ? (
                <TrendingDown className="h-2.5 w-2.5" />
              ) : null}
              {h.call}
            </Pill>
            <span className="font-mono text-[9.5px] text-muted-foreground/80">{h.confidence}</span>
          </div>
        ))}
      </div>

      {outlook.risks.length > 0 ? (
        <p className="mt-auto line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          <span className="font-medium text-foreground/70">Risks · </span>
          {outlook.risks.slice(0, 2).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

// ── Technicals — RSI/MOM only from real chart closes ──────────────────

export function CanvasTechnicalsNode({ sym }: { sym: string }) {
  const q = useQuery<ChartResp>({
    queryKey: ["company-chart", sym, "1Y"],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/chart?range=1Y`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`chart ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2 p-3.5">
        <SourceRow source="unconfigured" note="from chart closes" />
        <PanelSkeleton rows={4} />
      </div>
    );
  }

  const closes = (q.data?.points ?? [])
    .map((p) => p.c)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const source = chartSourceKind(q.data);
  const rsi = computeRsi(closes, 14);
  const mom20 = computeMomentum(closes, 20);
  const mom60 = computeMomentum(closes, 60);

  if (!q.data?.ok || closes.length < 15 || rsi == null) {
    return (
      <div className="p-3.5">
        <EmptyDataState
          reason="empty"
          message={`Not enough real closes for ${sym}.`}
          hint={`RSI(14) needs ≥15 closes from /chart. Got ${closes.length}. No synthetic RSI.`}
          badgeLabel="unavailable"
        />
      </div>
    );
  }

  const rsiTone: "success" | "neutral" | "destructive" =
    rsi >= 70 ? "destructive" : rsi <= 30 ? "success" : "neutral";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3.5">
      <SourceRow source={source} note={`RSI/MOM from ${closes.length} closes`} />
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-[hsl(var(--foreground)/0.03)] px-2.5 py-2.5">
          <p className="text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">RSI (14)</p>
          <div className="mt-1 flex items-baseline gap-2">
            <p className="font-mono text-lg font-semibold tabular-nums">{rsi.toFixed(1)}</p>
            <Pill tone={rsiTone} size="xs">
              {rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : "neutral"}
            </Pill>
          </div>
        </div>
        <div className="rounded-lg bg-[hsl(var(--foreground)/0.03)] px-2.5 py-2.5">
          <p className="text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">Mom 20d</p>
          <p
            className={cn(
              "mt-1 font-mono text-lg font-semibold tabular-nums",
              mom20 == null ? "text-muted-foreground" : mom20 >= 0 ? "text-up" : "text-down",
            )}
          >
            {mom20 != null ? `${mom20 >= 0 ? "+" : ""}${mom20.toFixed(1)}%` : "—"}
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-[hsl(var(--foreground)/0.03)] px-2.5 py-2.5">
        <p className="text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">Mom 60d</p>
        <p
          className={cn(
            "mt-1 font-mono text-[15px] font-semibold tabular-nums",
            mom60 == null ? "text-muted-foreground" : mom60 >= 0 ? "text-up" : "text-down",
          )}
        >
          {mom60 != null ? `${mom60 >= 0 ? "+" : ""}${mom60.toFixed(1)}%` : "—"}
        </p>
      </div>

      <p className="mt-auto text-[10.5px] leading-snug text-muted-foreground/70">
        Derived only from real /chart closes ({source === "iress" ? "IRESS" : "Yahoo"}). Missing windows show —.
      </p>
    </div>
  );
}

// ── News — real Yahoo headlines only; no invented sentiment ───────────

interface NewsResp {
  ok: boolean;
  symbol: string;
  items: Array<{
    title: string;
    url: string;
    publisher: string | null;
    publishedAt: string | null;
  }>;
  status?: string;
  detail?: string;
  error?: string;
}

export function CanvasNewsNode({ sym }: { sym: string }) {
  const fundQ = useQuery<CompanyAnalysis>({
    queryKey: ["company-analysis", sym],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`company-analysis ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 5 * 60_000,
  });
  const companyName = fundQ.data?.overview?.name ?? null;

  const q = useQuery<NewsResp>({
    queryKey: ["canvas-news", sym, companyName ?? ""],
    queryFn: async () => {
      const qs = companyName?.trim() ? `?q=${encodeURIComponent(companyName.trim())}` : "";
      const r = await fetch(`/api/company-analysis/${encodeURIComponent(sym)}/news${qs}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`news ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: Boolean(sym),
    staleTime: 10 * 60_000,
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2 p-3.5">
        <SourceRow source="unconfigured" note="GET …/news" />
        <PanelSkeleton rows={5} />
      </div>
    );
  }

  const items = q.data?.items ?? [];
  if (!items.length) {
    return (
      <div className="p-3.5">
        <EmptyDataState
          reason="empty"
          message={`No recent headlines for ${sym}.`}
          hint={q.data?.detail ?? q.data?.error ?? "Yahoo news returned empty — no invented headlines."}
          badgeLabel="yahoo"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3.5">
      <SourceRow source="yahoo" note={`${items.length} headline(s)`} />
      {items.slice(0, 6).map((item, i) => (
        <a
          key={`${item.url}-${i}`}
          href={item.url || undefined}
          target={item.url ? "_blank" : undefined}
          rel="noreferrer"
          className="block rounded-lg bg-[hsl(var(--foreground)/0.03)] px-2.5 py-2 transition-colors hover:bg-[hsl(var(--foreground)/0.055)]"
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="truncate text-[10px] text-muted-foreground">{item.publisher ?? "Yahoo"}</span>
            {item.publishedAt ? (
              <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground/70">
                {new Date(item.publishedAt).toLocaleDateString("en-ZA", {
                  day: "2-digit",
                  month: "short",
                })}
              </span>
            ) : null}
          </div>
          <p className="line-clamp-2 text-[12px] leading-snug text-foreground/90">{item.title}</p>
        </a>
      ))}
      <p className="mt-auto pt-1 text-[10px] text-muted-foreground/65">
        Real Yahoo headlines only — no synthetic sentiment scores.
      </p>
    </div>
  );
}

// ── Engine hub — structural layout routers (not live market streams) ──

export function CanvasEngineNode({
  title,
  hint,
  source = "hybrid",
}: {
  title: string;
  hint?: string;
  /** Provenance of the evidence this hub wires — never code-gap for intentional routers. */
  source?: DataSourceKind;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3.5 pb-2">
      <SourceRow source={source} note="layout router" />
      <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
        {hint?.trim() ||
          `${title} wires linked evidence nodes on this board. Live numbers live on the leaf nodes.`}
      </p>
    </div>
  );
}
