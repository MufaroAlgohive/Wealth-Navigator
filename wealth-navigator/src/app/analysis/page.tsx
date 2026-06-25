"use client";

/**
 * /analysis — standalone Company Analysis tab (sidebar: "Analysis").
 *
 * A duplicate-but-better take on fiscal.ai's company page
 * (e.g. https://fiscal.ai/company/NasdaqGS-MSFT/): Company Overview, grouped
 * Company Statistics (margins / returns / valuation TTM+NTM / health / growth /
 * dividends), Earnings beats, a price-history chart with return + CAGR — plus an
 * AI edge fiscal.ai doesn't have (thesis, bull/bear, what's happening).
 *
 * Works for ANY ticker (US, JSE .JO, global). Data: Yahoo Finance (free) for
 * fundamentals + price; MiniMax + web + Yahoo news for the AI thesis. Real values
 * or honest "—"; never fabricated.
 */

import { useQuery } from "@tanstack/react-query";
import { Globe, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { AiEdge, CompanyStatistics } from "@/components/analysis/company-analysis-panels";
import { CompanyPriceChart } from "@/components/analysis/company-price-chart";
import {
  DividendsTab,
  EstimatesTab,
  FilingsTab,
  FinancialsTab,
  IndustryTab,
  InvestorRelationsTab,
  ModelingTab,
  NewsTab,
  OwnershipTab,
  ResearchTab,
} from "@/components/analysis/analysis-tabs";
import { TickerSearch } from "@/components/analysis/ticker-search";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import type { CompanyAnalysis } from "@/lib/company-analysis/yahoo";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

const SUGGESTIONS = ["MSFT", "AAPL", "NVDA", "GOOGL", "AMZN", "TSLA", "NPN.JO", "CPI.JO"];

const SUBTABS = [
  { id: "overview", label: "Overview" },
  { id: "financials", label: "Financials" },
  { id: "estimates", label: "Estimates" },
  { id: "research", label: "Research" },
  { id: "news", label: "News" },
  { id: "ownership", label: "Insiders" },
  { id: "industry", label: "Industry" },
  { id: "dividends", label: "Dividends" },
  { id: "ir", label: "Investor Relations" },
  { id: "modeling", label: "Modeling" },
  { id: "filings", label: "Filings" },
] as const;
type SubTabId = (typeof SUBTABS)[number]["id"];

function ccySym(code: string): string {
  switch (code?.toUpperCase()) {
    case "USD": return "$";
    case "ZAR": return "R";
    case "GBP":
    case "GBX": return "£";
    case "EUR": return "€";
    case "JPY": return "¥";
    default: return code ? `${code} ` : "";
  }
}

function AnalysisTabContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sym = (searchParams.get("sym") ?? "MSFT").toUpperCase();

  const tabParam = searchParams.get("tab");
  const tab: SubTabId = SUBTABS.some((t) => t.id === tabParam) ? (tabParam as SubTabId) : "overview";

  const go = (next: string) => {
    const v = next.trim().toUpperCase();
    if (!v) return;
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.set("sym", v);
    router.replace(`/analysis?${sp.toString()}` as never);
  };
  const goTab = (t: SubTabId) => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.set("tab", t);
    router.replace(`/analysis?${sp.toString()}` as never);
  };

  // Header reads from the SAME query key as CompanyStatistics → one network call.
  const head = useQuery<CompanyAnalysis>({
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
  const d = head.data;
  const ok = d?.ok;
  const up = (d?.price.changePct ?? 0) >= 0;

  return (
    <div className="space-y-4 pb-8">
      {/* ── Title + search ── */}
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <div className="pointer-events-none absolute -right-24 -top-24 h-60 w-60 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h1 className="text-display text-2xl">Company Analysis</h1>
              <Pill tone="primary" size="xs">
                AI
              </Pill>
            </div>
            <p className="text-caption text-muted-foreground">
              Deep fundamentals, valuation, earnings and an AI thesis for any listed company. SA and global
              coverage, with an edge.
            </p>
          </div>
          <TickerSearch current={sym} onSelect={go} />
        </div>
        {/* Quick suggestions */}
        <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-caption font-mono text-muted-foreground">Try:</span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => go(s)}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
                s === sym
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-[hsl(var(--glass-border))] text-muted-foreground hover:border-[hsl(var(--glass-border-strong))] hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </header>

      {/* ── Company header (name + live price) ── */}
      <div className="glass-panel flex flex-wrap items-center justify-between gap-4 p-5">
        {head.isLoading ? (
          <PanelSkeleton rows={1} height="h-10" />
        ) : ok ? (
          <>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{d?.overview.name ?? sym}</h2>
                <span className="font-mono text-sm text-muted-foreground">{sym}</span>
                {d?.price.exchange ? (
                  <Pill tone="info" size="xs">
                    {d.price.exchange}
                  </Pill>
                ) : null}
                {d?.price.marketState ? (
                  <Pill tone={d.price.marketState === "REGULAR" ? "success" : "neutral"} dot size="xs">
                    {d.price.marketState}
                  </Pill>
                ) : null}
                {d?.overview.website ? (
                  <a
                    href={d.overview.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
                  >
                    <Globe className="h-3 w-3" />
                    site
                  </a>
                ) : null}
              </div>
              <p className="text-caption font-mono text-muted-foreground">
                {d?.currency ?? "—"} · {d?.overview.sector ?? "—"}
                {d?.overview.industry ? ` · ${d.overview.industry}` : ""}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-3xl font-semibold tabular-nums">
                  {d?.price.last != null
                    ? `${ccySym(d.currency)}${d.price.last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"}
                </span>
                <span
                  className={cn(
                    "font-mono text-sm font-semibold tabular-nums",
                    d?.price.changePct == null ? "text-muted-foreground" : up ? "text-up" : "text-down",
                  )}
                >
                  {d?.price.changePct == null
                    ? "—"
                    : `${up ? "+" : ""}${d.price.changePct.toFixed(2)}%`}
                </span>
              </div>
              <DataSourceBadge source={d?.price.priceSource === "iress" ? "iress" : "yahoo"} />
            </div>
          </>
        ) : (
          <div className="flex w-full items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">{sym}</h2>
              <p className="text-caption text-down">
                {head.error instanceof Error ? head.error.message : (d?.error ?? "No data for this symbol — check the ticker (US bare, JSE add .JO).")}
              </p>
            </div>
            <DataSourceBadge source="unavailable" />
          </div>
        )}
      </div>

      {/* ── Sub-tab strip ── */}
      <div role="tablist" aria-label="Analysis sections" className="glass-inset flex flex-wrap items-center gap-0.5 p-1">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => goTab(t.id)}
            className={cn(
              "h-8 rounded-lg px-3 text-[12px] font-medium transition-all duration-200",
              tab === t.id
                ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Active section ── */}
      {tab === "overview" && (
        <>
          <CompanyPriceChart sym={sym} />
          <CompanyStatistics sym={sym} />
          <AiEdge sym={sym} />
        </>
      )}
      {tab === "financials" && <FinancialsTab sym={sym} />}
      {tab === "estimates" && <EstimatesTab sym={sym} />}
      {tab === "research" && <ResearchTab sym={sym} />}
      {tab === "news" && <NewsTab sym={sym} />}
      {tab === "ownership" && <OwnershipTab sym={sym} />}
      {tab === "industry" && <IndustryTab sym={sym} />}
      {tab === "dividends" && <DividendsTab sym={sym} />}
      {tab === "ir" && <InvestorRelationsTab sym={sym} />}
      {tab === "modeling" && <ModelingTab sym={sym} />}
      {tab === "filings" && <FilingsTab sym={sym} />}
    </div>
  );
}

export default function AnalysisTabPage() {
  return (
    <Suspense fallback={<PanelSkeleton rows={6} height="h-[420px]" />}>
      <AnalysisTabContent />
    </Suspense>
  );
}
