"use client";

/**
 * Fiscal.ai-style Analysis panels — a richer take on fiscal.ai's company page.
 *
 *   <CompanyStatistics />  Company Overview + grouped statistics (Profile,
 *                          Margins, Returns, Valuation TTM/NTM, Health, Growth,
 *                          Dividends) + Earnings beats + a revenue/earnings trend.
 *                          Sourced from /api/company-analysis (Yahoo, free) —
 *                          real values or honest "—"; never fabricated.
 *   <AiEdge />             The edge fiscal.ai doesn't have: an AI thesis (short /
 *                          medium / long calls), a bull/bear split, key risks and
 *                          "what's happening", from /api/research-ai (MiniMax +
 *                          web + Yahoo news). Honest "not configured" deferred.
 *
 * Works for any ticker (MSFT, AAPL, CPI.JO, …). JSE cents are handled upstream.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  Building2,
  ExternalLink,
  Globe,
  Newspaper,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useState } from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import type { AnalysisMetric, CompanyAnalysis } from "@/lib/company-analysis/yahoo";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

// ── formatting ────────────────────────────────────────────────────────

function currencySymbol(code: string): string {
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

/** Abbreviate a large magnitude: 2.62T, 318.27B, 1.2M. */
function abbrev(v: number, dp = 2): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(dp)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(dp)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Render a metric value to its display string per its `fmt`. "—" when null. */
function fmtMetric(m: AnalysisMetric, currency: string): string {
  const v = m.value;
  if (v == null || !Number.isFinite(v)) return "—";
  const sym = currencySymbol(currency);
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

/** Whether a metric reads positive (green) for the few groups where sign matters. */
function metricTone(group: string, key: string, m: AnalysisMetric): "up" | "down" | "none" {
  if (m.value == null) return "none";
  if (group === "Growth (CAGR)") return m.value >= 0 ? "up" : "down";
  if (group === "Margins" || group === "Returns") return m.value > 0 ? "up" : "down";
  return "none";
}

const GROUP_ICON: Record<string, React.ReactNode> = {
  Profile: <Building2 className="h-3.5 w-3.5" />,
  Margins: <Activity className="h-3.5 w-3.5" />,
  Returns: <TrendingUp className="h-3.5 w-3.5" />,
  "Valuation (TTM)": <TrendingUp className="h-3.5 w-3.5" />,
  "Valuation (NTM)": <TrendingUp className="h-3.5 w-3.5" />,
  "Financial Health": <Activity className="h-3.5 w-3.5" />,
  "Growth (CAGR)": <TrendingUp className="h-3.5 w-3.5" />,
  Dividends: <Sparkles className="h-3.5 w-3.5" />,
};

// ── Company statistics (Yahoo) ──────────────────────────────────────────

export function CompanyStatistics({ sym }: { sym: string }) {
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

  if (q.isLoading) return <PanelSkeleton rows={6} height="h-[360px]" />;

  const d = q.data;
  if (!d || !d.ok) {
    return (
      <GlassSection
        title="Company statistics"
        subtitle="Yahoo Finance — deep fundamentals"
        endpoint="GET /api/company-analysis"
        dataSource="yahoo"
      >
        <EmptyDataState
          reason="empty"
          message={`No deep fundamentals returned for ${sym}.`}
          hint={d?.error ?? q.error instanceof Error ? (d?.error ?? (q.error as Error).message) : "Yahoo did not return a profile for this symbol."}
          badgeLabel="yahoo"
        />
      </GlassSection>
    );
  }

  const ccy = d.currency;
  const o = d.overview;
  const fmtAsOf = d.asOf
    ? new Date(d.asOf).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })
    : null;

  return (
    <div className="space-y-4">
      {/* ── Company overview ── */}
      <GlassSection
        title="Company overview"
        subtitle={`Yahoo Finance${fmtAsOf ? ` · as of ${fmtAsOf} SAST` : ""}`}
        endpoint="GET /api/company-analysis"
        dataSource="yahoo"
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{o.name ?? d.symbol}</h3>
              {o.sector ? (
                <Pill tone="info" size="xs">
                  {o.sector}
                </Pill>
              ) : null}
              {o.industry ? (
                <Pill tone="neutral" size="xs">
                  {o.industry}
                </Pill>
              ) : null}
            </div>
            {o.description ? (
              <Description text={o.description} />
            ) : (
              <p className="text-caption text-muted-foreground">No business summary on the Yahoo feed.</p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-px self-start overflow-hidden rounded-xl border border-[hsl(var(--glass-border))] sm:grid-cols-2 lg:grid-cols-1">
            <OverviewFact icon={<Users className="h-3.5 w-3.5" />} k="CEO" v={o.ceo ?? "—"} />
            <OverviewFact
              icon={<Globe className="h-3.5 w-3.5" />}
              k="Website"
              v={
                o.website ? (
                  <a
                    href={o.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {o.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <OverviewFact icon={<Building2 className="h-3.5 w-3.5" />} k="Country" v={o.country ?? "—"} />
            <OverviewFact
              icon={<Users className="h-3.5 w-3.5" />}
              k="Employees"
              v={o.employees != null ? o.employees.toLocaleString("en-US") : "—"}
            />
          </div>
        </div>
      </GlassSection>

      {/* ── Company statistics (grouped) ── */}
      <GlassSection
        title="Company statistics"
        subtitle="Yahoo Finance — margins, returns, valuation, growth, health"
        endpoint="GET /api/company-analysis"
        dataSource="yahoo"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Object.entries(d.groups).map(([group, metrics]) => (
            <div
              key={group}
              className="glass-inset flex flex-col overflow-hidden rounded-xl"
            >
              <div className="flex items-center gap-1.5 border-b border-[hsl(var(--glass-border))] px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {GROUP_ICON[group] ?? <Activity className="h-3.5 w-3.5" />}
                {group}
              </div>
              <div className="divide-y divide-[hsl(var(--glass-border))]/50">
                {Object.entries(metrics).map(([key, m]) => {
                  const tone = metricTone(group, key, m);
                  return (
                    <div key={key} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="text-[11.5px] text-muted-foreground">{key}</span>
                      <span
                        className={cn(
                          "font-mono text-xs font-semibold tabular-nums",
                          tone === "up" && "text-up",
                          tone === "down" && "text-down",
                        )}
                      >
                        {fmtMetric(m, ccy)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {d.notes.length ? (
          <ul className="mt-3 space-y-1">
            {d.notes.map((note, i) => (
              <li key={i} className="text-[10.5px] leading-snug text-muted-foreground/80">
                · {note}
              </li>
            ))}
          </ul>
        ) : null}
      </GlassSection>

      {/* ── Earnings + trend ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GlassSection
          title="Earnings"
          subtitle="Latest reported quarter + EPS beat record"
          endpoint="GET /api/company-analysis"
          dataSource="yahoo"
        >
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]">
            <EarnFact
              k="Latest quarter"
              v={d.earnings.quarter ?? "—"}
            />
            <EarnFact
              k="Quarterly revenue"
              v={d.earnings.revenue != null ? `${currencySymbol(ccy)}${abbrev(d.earnings.revenue)}` : "—"}
            />
            <EarnFact
              k="EPS beats"
              v={
                d.earnings.epsBeatRate
                  ? `${d.earnings.epsBeatRate.beats} / ${d.earnings.epsBeatRate.total} quarters`
                  : "—"
              }
              tone={
                d.earnings.epsBeatRate && d.earnings.epsBeatRate.beats / Math.max(1, d.earnings.epsBeatRate.total) >= 0.6
                  ? "up"
                  : "none"
              }
            />
            <EarnFact
              k="Beat rate"
              v={
                d.earnings.epsBeatRate
                  ? `${Math.round((d.earnings.epsBeatRate.beats / Math.max(1, d.earnings.epsBeatRate.total)) * 100)}%`
                  : "—"
              }
            />
          </div>
          <p className="mt-2 text-[10.5px] text-muted-foreground/80">
            Yahoo exposes the last 4 reported quarters. A longer beat history (10y+) needs a paid estimates
            vendor.
          </p>
        </GlassSection>

        <GlassSection
          title="Revenue & net income"
          subtitle={`Annual, ${ccy} — Yahoo income statements`}
          endpoint="GET /api/company-analysis"
          dataSource="yahoo"
          noPadding
        >
          <div className="p-4">
            <TrendChart series={d.series} currency={ccy} />
          </div>
        </GlassSection>
      </div>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320;
  return (
    <div>
      <p className={cn("text-[12.5px] leading-relaxed text-muted-foreground", !open && long && "line-clamp-4")}>
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 font-mono text-[10.5px] text-primary hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function OverviewFact({ icon, k, v }: { icon: React.ReactNode; k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-[hsl(var(--foreground)/0.015)] px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {k}
      </span>
      <span className="truncate text-right font-mono text-xs font-semibold">{v}</span>
    </div>
  );
}

function EarnFact({ k, v, tone = "none" }: { k: string; v: string; tone?: "up" | "none" }) {
  return (
    <div className="flex flex-col gap-0.5 bg-[hsl(var(--foreground)/0.015)] px-3 py-2.5">
      <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">{k}</span>
      <span className={cn("font-mono text-sm font-semibold tabular-nums", tone === "up" && "text-up")}>{v}</span>
    </div>
  );
}

function TrendChart({ series, currency }: { series: CompanyAnalysis["series"]; currency: string }) {
  // Yahoo returns most-recent-first; reverse to chronological left→right.
  const rows = series.years
    .map((year, i) => ({
      year: String(year),
      revenue: series.revenue[i] ?? null,
      netIncome: series.netIncome[i] ?? null,
    }))
    .reverse();

  if (rows.length < 2) {
    return (
      <EmptyDataState
        reason="empty"
        message="Not enough annual history to chart."
        hint="Yahoo returned fewer than two annual income statements for this symbol."
        badgeLabel="yahoo"
      />
    );
  }

  const sym = currencySymbol(currency);
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="year"
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
          axisLine={{ stroke: "hsl(var(--glass-border))" }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={48}
          tickFormatter={(v: number) => `${sym}${abbrev(v, 0)}`}
        />
        <RTooltip
          cursor={{ fill: "hsl(var(--primary)/0.06)" }}
          contentStyle={{
            background: "hsl(var(--popover, var(--background)))",
            border: "1px solid hsl(var(--glass-border))",
            borderRadius: 12,
            fontSize: 12,
          }}
          formatter={(value: number, name: string) => [`${sym}${abbrev(value)}`, name === "revenue" ? "Revenue" : "Net income"]}
        />
        <Bar dataKey="revenue" name="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={48} />
        <Line
          dataKey="netIncome"
          name="netIncome"
          type="monotone"
          stroke="hsl(var(--up))"
          strokeWidth={2}
          dot={{ r: 3, fill: "hsl(var(--up))" }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── AI edge (the differentiator) ────────────────────────────────────────

interface OutlookHorizon {
  horizon: string;
  call: "bullish" | "neutral" | "bearish" | string;
  confidence: "low" | "medium" | "high" | string;
  rationale: string;
}
interface AiResearch {
  ok: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  generatedAt: string | null;
  cacheStatus?: string;
  outlook: {
    summary: string;
    shortTerm: OutlookHorizon;
    mediumTerm: OutlookHorizon;
    longTerm: OutlookHorizon;
    risks: string[];
  } | null;
  sources: Array<{ title: string; url: string | null }>;
  error?: string;
}

function callTone(call: string): "success" | "neutral" | "destructive" {
  if (call === "bullish") return "success";
  if (call === "bearish") return "destructive";
  return "neutral";
}

export function AiEdge({ sym }: { sym: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const q = useQuery<AiResearch>({
    queryKey: ["ai-edge", sym, refreshKey],
    queryFn: async () => {
      const r = await fetch(
        `/api/research-ai?symbol=${encodeURIComponent(sym)}${refreshKey > 0 ? "&refresh=1" : ""}`,
        { cache: "no-store" },
      );
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
  const horizons = outlook
    ? ([
        ["Short · 0–3m", outlook.shortTerm],
        ["Medium · 3–12m", outlook.mediumTerm],
        ["Long · 1–3y", outlook.longTerm],
      ] as Array<[string, OutlookHorizon]>)
    : [];
  // Bull case = rationales of any horizon the model calls bullish; bear case =
  // the model's explicit risk list. Both are the model's own words, not ours.
  const bullCase = horizons.filter(([, h]) => h.call === "bullish").map(([label, h]) => ({ label, text: h.rationale }));
  const bearCase = outlook?.risks ?? [];

  return (
    <GlassSection
      title="AI edge"
      subtitle={
        d?.configured === false
          ? "AI provider not configured"
          : "AI-generated thesis · grounded on financials, web and recent news"
      }
      endpoint="GET /api/research-ai"
      dataSource="external"
      right={
        <div className="flex items-center gap-2">
          <Pill tone="primary" size="xs">
            <Sparkles className="h-2.5 w-2.5" /> AI
          </Pill>
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={q.isFetching}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] px-2 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            title="Regenerate (forces a fresh model call)"
          >
            <RefreshCw className={cn("h-3 w-3", q.isFetching && "animate-spin")} />
            {q.isFetching ? "Thinking…" : "Regenerate"}
          </button>
        </div>
      }
    >
      {q.isLoading || q.isFetching ? (
        <div className="space-y-3">
          <p className="inline-flex items-center gap-2 text-caption text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" />
            Grounding on fundamentals, web research and recent news, then synthesizing the thesis…
          </p>
          <PanelSkeleton rows={4} />
        </div>
      ) : !outlook ? (
        <EmptyDataState
          reason="empty"
          message={d?.configured === false ? "AI research provider not configured." : `No AI thesis generated for ${sym}.`}
          hint={
            d?.configured === false
              ? "The AI thesis is not enabled in this environment. The fundamentals and price chart above are live."
              : (d?.error ?? "The model returned no usable outlook. Try Regenerate.")
          }
          badgeLabel="unconfigured"
        />
      ) : (
        <div className="space-y-4">
          {/* Thesis summary */}
          <p className="text-[13px] leading-relaxed">{outlook.summary}</p>

          {/* Horizon calls */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {horizons.map(([label, h]) => (
              <div key={label} className="glass-inset rounded-xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">{label}</span>
                  <Pill tone={callTone(h.call)} size="xs">
                    {h.call === "bullish" ? (
                      <TrendingUp className="h-2.5 w-2.5" />
                    ) : h.call === "bearish" ? (
                      <TrendingDown className="h-2.5 w-2.5" />
                    ) : null}
                    {h.call}
                  </Pill>
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">confidence: {h.confidence}</p>
                <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">{h.rationale}</p>
              </div>
            ))}
          </div>

          {/* Bulls / Bears */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-success/25 bg-success/5 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-up">
                <ThumbsUp className="h-3.5 w-3.5" /> Bull case
              </div>
              {bullCase.length ? (
                <ul className="mt-2 space-y-1.5">
                  {bullCase.map((b, i) => (
                    <li key={i} className="text-[11.5px] leading-snug text-muted-foreground">
                      <span className="font-mono text-[9.5px] text-up">{b.label}</span> · {b.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  The model does not call any horizon bullish on current evidence.
                </p>
              )}
            </div>
            <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-down">
                <ThumbsDown className="h-3.5 w-3.5" /> Bear case · key risks
              </div>
              {bearCase.length ? (
                <ul className="mt-2 space-y-1.5">
                  {bearCase.map((r, i) => (
                    <li key={i} className="text-[11.5px] leading-snug text-muted-foreground">
                      · {r}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11.5px] text-muted-foreground">No explicit risks flagged.</p>
              )}
            </div>
          </div>

          {/* What's happening (sources) */}
          {d?.sources?.length ? (
            <div>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Newspaper className="h-3.5 w-3.5" /> What&apos;s happening
              </div>
              <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {d.sources.slice(0, 8).map((s, i) => (
                  <li key={i} className="truncate text-[11.5px]">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 text-muted-foreground hover:text-primary hover:underline"
                      >
                        <span className="truncate">{s.title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{s.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-[10px] leading-snug text-muted-foreground/70">
            AI-generated, grounded on the gathered evidence. Not investment advice.
            {d?.generatedAt
              ? ` Generated ${new Date(d.generatedAt).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })} SAST.`
              : ""}
            {d?.cacheStatus === "hit" ? " Reused from cache (no new tokens)." : ""}
          </p>
        </div>
      )}
    </GlassSection>
  );
}
