"use client";

// AI Research panel (Research Lab → "AI Research" tab).
//
// Lets the analyst pick a JSE security and run an LLM-backed research pass via
// the BFF at GET /api/research-ai?symbol=<TICKER>[&refresh=1]. The response shape
// is the shared AiResearchResponse contract exported from
// "@/lib/research-ai/provider" (the BFF owns generation; this file only renders).
//
// CACHING is the headline token-saving feature: the BFF reuses a stored answer
// when nothing material changed (cacheStatus "hit", 0 tokens) and only
// regenerates when it must ("refreshed"). The panel surfaces that status plainly
// so the desk can see when no model spend occurred.
//
// Data is mock/placeholder for now — the panel uses the deferred-bucket pattern:
//   • configured:false  → honest "not configured" notice naming the env var,
//                          still rendering whatever real `gathered` data exists.
//   • outlook:null       → no fabricated calls; we show the gathered facts only.
//   • cacheStatus:"uncached" → research store not provisioned yet (data phase).
// Nothing here invents numbers.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  Database,
  ExternalLink,
  KeyRound,
  Minus,
  Newspaper,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import { GlassBadge, GlassSection } from "@/components/oems/primitives/glass";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Pill } from "@/components/oems/primitives/pill";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { AiResearchResponse } from "@/lib/research-ai/provider";

// The shared GET /api/research-ai contract (AiResearchResponse) already carries
// the caching metadata (cacheStatus / cached / cacheReason) as required fields,
// so the panel renders it directly — no local extension needed.

// Non-null outlook + one horizon band, derived from the shared contract so this
// stays in lockstep with AiResearchResponse without re-declaring the shape.
type Outlook = NonNullable<AiResearchResponse["outlook"]>;
type OutlookBand = Outlook["shortTerm"];
type Call = OutlookBand["call"];

const CALL_TONE: Record<Call, "success" | "neutral" | "destructive"> = {
  bullish: "success",
  neutral: "neutral",
  bearish: "destructive",
};

const CONFIDENCE_TONE: Record<"low" | "medium" | "high", "neutral" | "info" | "primary"> = {
  low: "neutral",
  medium: "info",
  high: "primary",
};

function CallIcon({ call }: { call: Call }) {
  if (call === "bullish") return <TrendingUp className="h-3.5 w-3.5" />;
  if (call === "bearish") return <TrendingDown className="h-3.5 w-3.5" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
}

interface OutlookRowProps {
  label: string;
  horizon: string;
  band: OutlookBand;
}

function OutlookRow({ label, horizon, band }: OutlookRowProps) {
  return (
    <div className="glass-inset flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex shrink-0 items-center gap-2 sm:w-44">
        <span className="text-sm font-semibold">{label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{horizon}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={CALL_TONE[band.call]} size="sm">
            <CallIcon call={band.call} />
            {band.call}
          </Pill>
          <Pill tone={CONFIDENCE_TONE[band.confidence]} size="sm">
            {band.confidence} confidence
          </Pill>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{band.rationale}</p>
      </div>
    </div>
  );
}

/**
 * Cache indicator — the visible token-saving signal.
 *   hit       → calm "Cached" pill + why-reused reason ("no tokens used").
 *   refreshed → "Refreshed" pill + why-regenerated reason.
 *   miss      → "New" pill (first answer generated for this security).
 *   uncached  → subtle muted note (research store not provisioned yet).
 */
function CacheIndicator({ data }: { data: AiResearchResponse }) {
  if (data.cacheStatus === "uncached") {
    return (
      <p className="flex items-center gap-1.5 text-caption">
        <Database className="h-3 w-3 text-muted-foreground/70" />
        Caching activates once the research store is provisioned (data phase).
      </p>
    );
  }

  if (data.cacheStatus === "hit") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="success" size="sm" dot>
          <CheckCircle2 className="h-3 w-3" />
          Cached
        </Pill>
        <span className="text-xs text-muted-foreground">
          {data.cacheReason ?? "No material change — reused prior research, no tokens used."}
        </span>
      </div>
    );
  }

  if (data.cacheStatus === "refreshed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="info" size="sm">
          <RefreshCw className="h-3 w-3" />
          Refreshed
        </Pill>
        <span className="text-xs text-muted-foreground">
          {data.cacheReason ?? "Regenerated — a material change was detected since the last pass."}
        </span>
      </div>
    );
  }

  // miss
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill tone="primary" size="sm">
        <Sparkles className="h-3 w-3" />
        New
      </Pill>
      <span className="text-xs text-muted-foreground">
        {data.cacheReason ?? "First research pass for this security — stored for reuse."}
      </span>
    </div>
  );
}

/**
 * Step-by-step research trace — shows the analyst exactly what the pipeline did:
 * which sources it gathered, what it found, and what is missing or deferred
 * (online web research, Iress financials). No black box.
 */
type TraceStep = AiResearchResponse["trace"][number];

const STEP_STYLE: Record<
  TraceStep["status"],
  { Icon: typeof CheckCircle2; cls: string }
> = {
  ok: { Icon: CheckCircle2, cls: "text-emerald-500" },
  empty: { Icon: Minus, cls: "text-muted-foreground/60" },
  skipped: { Icon: Minus, cls: "text-muted-foreground/50" },
  deferred: { Icon: Clock, cls: "text-amber-500" },
  error: { Icon: AlertTriangle, cls: "text-destructive" },
};

function ResearchTrace({ steps }: { steps: TraceStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="glass-inset px-4 py-3">
      <p className="mb-1 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-muted-foreground">
        <Bot className="h-3.5 w-3.5" /> How this was produced
      </p>
      <ol className="divide-y divide-[hsl(var(--glass-border))]/40">
        {steps.map((s, i) => {
          const { Icon, cls } = STEP_STYLE[s.status];
          return (
            <li key={i} className="flex items-start gap-2.5 py-1.5">
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", cls)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium">{s.label}</span>
                  {s.source && (
                    <span className="font-mono text-[10px] text-muted-foreground">{s.source}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{s.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function AiResearch() {
  // Reuse the JSE-universe search pattern from research-lab-page: fetch the
  // /api/equities universe once and filter client-side.
  const equitiesQ = useQuery<{
    securities: Array<{ symbol: string; name: string | null }>;
  }>({
    queryKey: ["equities-universe"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      if (!r.ok) throw new Error(`equities ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const [query, setQuery] = useState("");
  const [symbol, setSymbol] = useState<string | null>(null);
  // The run key carries both the symbol and a refresh nonce so a "Force new"
  // click re-fetches with &refresh=1 even for the same ticker.
  const [run, setRun] = useState<{ symbol: string; refresh: number } | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (q.length < 1) return [];
    return (equitiesQ.data?.securities ?? [])
      .map((s) => ({ ticker: s.symbol.replace(/\.JO$/i, ""), name: s.name ?? s.symbol }))
      .filter((s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q))
      .slice(0, 8);
  }, [query, equitiesQ.data?.securities]);

  const researchQ = useQuery<AiResearchResponse>({
    queryKey: ["research-ai", run?.symbol, run?.refresh],
    queryFn: async () => {
      const force = (run?.refresh ?? 0) > 0 ? "&refresh=1" : "";
      const r = await fetch(
        `/api/research-ai?symbol=${encodeURIComponent(run?.symbol ?? "")}${force}`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error(`research-ai ${r.status}`);
      return r.json();
    },
    enabled: Boolean(run?.symbol),
    staleTime: 0,
  });

  const pick = (ticker: string, name: string) => {
    setSymbol(ticker);
    setQuery(`${ticker} — ${name}`);
  };

  const resolveSymbol = () =>
    (symbol ?? query.trim().split(/\s+/)[0] ?? "").replace(/\.JO$/i, "").toUpperCase();

  // "Run AI research" — cache-first (no refresh flag; BFF reuses if unchanged).
  const runResearch = () => {
    const sym = resolveSymbol();
    if (!sym) {
      toast.error("Pick or type a security symbol first.");
      return;
    }
    setSymbol(sym);
    setRun({ symbol: sym, refresh: 0 });
  };

  // "Force new" — same URL with &refresh=1 to bypass the cache and regenerate.
  const forceRefresh = () => {
    const sym = run?.symbol ?? resolveSymbol();
    if (!sym) {
      toast.error("Run research on a security first.");
      return;
    }
    setRun({ symbol: sym, refresh: Date.now() });
  };

  const data = researchQ.data;

  // "Submit to investment committee" — UI shell only. In the data phase this
  // routes into the existing /compliance approvals queue + the Research Lab
  // committee queue (same workflow that session proposals feed).
  const submitToCommittee = () => {
    toast.success("Routed to committee (deferred to the data phase)");
  };

  return (
    <GlassSection
      title="AI Research"
      subtitle="LLM-assisted outlook per security — grounded in real fundamentals + news, cached to save tokens"
      endpoint="/api/research-ai"
      dataSource="code-gap"
      right={
        <GlassBadge tone="primary">
          <Sparkles className="h-3 w-3" />
          MINT AI
        </GlassBadge>
      }
    >
      <div className="space-y-4">
        {/* Selector */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search JSE universe — ticker or company name…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSymbol(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") runResearch();
              }}
              className="glass-inset h-11 border-0 pl-10 text-sm shadow-none"
            />
            {candidates.length > 0 && !symbol && (
              <ul className="glass-panel absolute z-20 mt-1 max-h-64 w-full divide-y divide-[hsl(var(--glass-border))] overflow-auto border border-[hsl(var(--glass-border))] backdrop-blur-xl">
                {candidates.map((c) => (
                  <li key={c.ticker}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-[hsl(var(--primary)/0.06)]"
                      onClick={() => pick(c.ticker, c.name)}
                    >
                      <span>
                        <span className="font-semibold text-primary">{c.ticker}</span>
                        <span className="ml-2 text-muted-foreground">{c.name}</span>
                      </span>
                      <ChevronDown className="h-3 w-3 rotate-[-90deg] text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            type="button"
            onClick={runResearch}
            disabled={researchQ.isFetching}
            className="h-11 shrink-0 gap-2 bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)] hover:bg-primary/90"
          >
            <Bot className={cn("h-4 w-4", researchQ.isFetching && "animate-pulse")} />
            {researchQ.isFetching ? "Researching…" : "Run AI research"}
          </Button>
          {/* Force new — bypasses the cache (&refresh=1). Only useful once a run
              exists, so it stays disabled until then. */}
          <Button
            type="button"
            variant="outline"
            onClick={forceRefresh}
            disabled={researchQ.isFetching || !run?.symbol}
            className="glass-inset h-11 shrink-0 gap-2 border-0"
            title="Bypass cache and regenerate"
          >
            <RefreshCw className={cn("h-4 w-4", researchQ.isFetching && "animate-spin")} />
            Force new
          </Button>
        </div>

        {/* States */}
        {!run && !researchQ.isFetching && (
          <EmptyDataState
            title="Pick a security to research"
            message="Search the JSE universe above, then run an AI research pass."
            hint="Outlook is LLM-generated when a provider key is configured; repeated runs reuse the cache."
            badgeLabel="code-gap"
          />
        )}

        {researchQ.isFetching && (
          <div className="space-y-3">
            <div className="h-16 animate-pulse rounded-2xl bg-[hsl(var(--foreground)/0.05)]" />
            <div className="h-20 animate-pulse rounded-2xl bg-[hsl(var(--foreground)/0.05)]" />
            <div className="grid gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-2xl bg-[hsl(var(--foreground)/0.05)]" />
              ))}
            </div>
          </div>
        )}

        {!researchQ.isFetching && researchQ.isError && (
          <EmptyDataState
            message="AI research failed."
            hint={researchQ.error instanceof Error ? researchQ.error.message : "Retry the run."}
            badgeLabel="unavailable"
          />
        )}

        {!researchQ.isFetching && data && (
          <div className="space-y-4">
            {/* Header */}
            <div className="glass-inset flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-base font-semibold text-primary">{data.symbol}</span>
                  <span className="truncate text-sm text-muted-foreground">{data.name ?? "—"}</span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {data.generatedAt
                    ? `Generated ${new Date(data.generatedAt).toLocaleString("en-ZA", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : "Not generated"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {data.provider && data.model ? (
                  <Pill tone="primary" size="sm">
                    {data.provider} · {data.model}
                  </Pill>
                ) : (
                  <Pill tone="neutral" size="sm">
                    no model
                  </Pill>
                )}
              </div>
            </div>

            {/* Cache indicator — the visible token-saving signal. Suppressed on a
                synthesis failure (ok:false): nothing was stored, so the "New …
                stored for reuse" pill would falsely claim a cache write. The
                honest uncached / not-configured note (ok:true, outlook:null) is
                still shown. */}
            {data.ok && (data.outlook !== null || data.cacheStatus === "uncached") && (
              <CacheIndicator data={data} />
            )}

            {/* Gathered chips */}
            <div className="flex flex-wrap gap-2">
              <Pill tone={data.gathered.fundamentals ? "success" : "neutral"} size="sm" dot>
                Fundamentals {data.gathered.fundamentals ? "present" : "—"}
              </Pill>
              <Pill tone="info" size="sm">
                <Newspaper className="h-3 w-3" />
                {data.gathered.newsCount} news
              </Pill>
              {data.gathered.priceSummary ? (
                <Pill
                  tone={
                    data.gathered.priceSummary.changePct == null
                      ? "neutral"
                      : data.gathered.priceSummary.changePct >= 0
                        ? "success"
                        : "destructive"
                  }
                  size="sm"
                >
                  Last {data.gathered.priceSummary.last ?? "—"}
                  {data.gathered.priceSummary.changePct != null
                    ? ` · ${data.gathered.priceSummary.changePct >= 0 ? "+" : ""}${data.gathered.priceSummary.changePct.toFixed(2)}%`
                    : ""}
                </Pill>
              ) : (
                <Pill tone="neutral" size="sm">
                  Price —
                </Pill>
              )}
            </div>

            {/* Step-by-step trace — what the pipeline gathered + what's deferred. */}
            <ResearchTrace steps={data.trace} />

            {/* Not-configured notice (deferred bucket) */}
            {!data.configured && (
              <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-warning">AI provider not configured</p>
                  <p className="text-muted-foreground">
                    {data.error ??
                      "No model API key is set, so no outlook was generated. The gathered fundamentals, price, and news count above are real where available."}
                  </p>
                  <p className="text-caption">
                    Set <span className="font-mono">MINIMAX_API_KEY</span> or{" "}
                    <span className="font-mono">ANTHROPIC_API_KEY</span> in the server environment to enable
                    generation.
                  </p>
                </div>
              </div>
            )}

            {/* Outlook */}
            {data.outlook ? (
              <div className="space-y-3">
                <div className="glass-inset px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Summary
                  </p>
                  <p className="mt-1 text-sm leading-relaxed">{data.outlook.summary}</p>
                </div>

                <div className="grid gap-2">
                  <OutlookRow label="Short term" horizon="0–3 months" band={data.outlook.shortTerm} />
                  <OutlookRow label="Medium term" horizon="3–12 months" band={data.outlook.mediumTerm} />
                  <OutlookRow label="Long term" horizon="1–3 years" band={data.outlook.longTerm} />
                </div>

                {data.outlook.risks.length > 0 && (
                  <div className="glass-inset px-4 py-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <AlertTriangle className="h-3 w-3" />
                      Key risks
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {data.outlook.risks.map((risk, i) => (
                        <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-destructive" />
                          <span className="leading-relaxed">{risk}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              data.configured && (
                <EmptyDataState
                  message="No outlook generated."
                  hint={data.error ?? "The model returned no outlook for this security."}
                  badgeLabel="code-gap"
                />
              )
            )}

            {/* Sources */}
            {data.sources.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Sources
                </p>
                <ul className="flex flex-wrap gap-2">
                  {data.sources.map((s, i) => (
                    <li key={i}>
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="glass-inset inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-primary transition-colors hover:border-[hsl(var(--glass-border-strong))]"
                        >
                          {s.title}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="glass-inset inline-flex items-center px-3 py-1.5 text-xs text-muted-foreground">
                          {s.title}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Disclaimer */}
            {data.disclaimer && (
              <p className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] px-4 py-2.5 text-caption leading-relaxed">
                {data.disclaimer}
              </p>
            )}

            {/* Route to committee — UI shell (ties into /compliance approvals +
                the Research Lab committee queue in the data phase). */}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={submitToCommittee}
                className="glass-inset gap-1.5 border-0"
              >
                <Send className="h-4 w-4" />
                Submit to investment committee
              </Button>
            </div>
          </div>
        )}
      </div>
    </GlassSection>
  );
}
