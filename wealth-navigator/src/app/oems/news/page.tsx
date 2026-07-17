"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, AlertCircle } from "lucide-react";

import { GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface NewsItem {
  id: string;
  source: string;
  category: string;
  severity: "low" | "medium" | "high" | "regulatory" | string;
  ticker: string | null;
  issuer: string | null;
  headline: string;
  body: string | null;
  url: string | null;
  publishedAt: string;
  ts: number;
  priority: "low" | "high";
  tickers: string[];
}

interface NewsResponse {
  items: NewsItem[];
  source: string;
  message?: string;
}

const TAB_TRIGGER =
  "h-7 rounded-lg px-3 text-[11px] font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_2px_12px_hsl(var(--primary)/0.35)]";

export default function NewsPage() {
  const realDataOnly = isRealDataOnlyClient();
  const newsQ = useQuery<NewsResponse>({
    queryKey: ["bff-news"],
    queryFn: async () => {
      const r = await fetch("/api/news?limit=100", { cache: "no-store" });
      if (!r.ok) throw new Error(`News BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const items = newsQ.data?.items ?? [];

  // JSE SENS announcements from the IRESS PROD feed (NewsVendorGet passthrough).
  // Dormant until Charles entitles the SENS vendor — returns 0 rows today, so the
  // SENS tab falls back to the (empty) /api/news bucket. Lights up automatically
  // the moment the feed delivers, no further code change needed.
  const sensQ = useQuery<{
    ok?: boolean;
    headlines?: Array<{
      storyId?: string;
      headline?: string;
      source?: string;
      timestamp?: string;
      ts?: number;
      relatedCodes?: string[];
      storyPreview?: string;
    }>;
  }>({
    queryKey: ["iress-sens"],
    queryFn: async () => {
      const r = await fetch("/api/iress/news?vendor=SENS&pageSize=50", { cache: "no-store" });
      if (!r.ok) return { ok: false, headlines: [] };
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  // Hooks must run unconditionally (Rules of Hooks): declare them BEFORE the
  // mock-mode early return below, so the hook count doesn't change when
  // realDataOnly flips (e.g. ?mock=1), which would trip a hydration mismatch.
  const [tab, setTab] = useState<"all" | "sens" | "wire">("all");
  const [q, setQ] = useState("");
  // Alliance wire items have no external URL (licensed full-text); clicking
  // them expands the body in-app. RSS items link out instead.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!realDataOnly) {
    return (
      <PageCanvas>
        <header>
          <h1 className="text-lg font-semibold tracking-tight">News & SENS</h1>
          <p className="text-xs text-muted-foreground">Reuters · Bloomberg · Moneyweb · Dow Jones · SENS regulatory tape</p>
        </header>
        <GlassSection title="News tape" db="retail" dataSource="external" endpoint="GET /api/news">
          <EmptyDataState
            message="Mock mode disables the news module."
            hint="Switch to real-data mode and ensure the worker has written news_item_c rows."
            badgeLabel="mock"
          />
        </GlassSection>
      </PageCanvas>
    );
  }

  // /api/news returns the Alliance News wire from the retail News_articles feed,
  // tagged category "WIRE". SENS (category "SENS") needs a separate JSE SENS
  // subscription, so that bucket is empty for now. Bucket client-side.
  // SENS bucket: the IRESS prod feed (NewsVendorGet) first, then any /api/news
  // SENS-tagged items. Empty today (feed dormant) → same empty state as before.
  const sensFromIress: NewsItem[] = (sensQ.data?.headlines ?? []).map((h, i) => ({
    id: h.storyId ?? `iress-sens-${i}`,
    source: h.source ?? "SENS",
    category: "SENS",
    severity: "regulatory",
    ticker: h.relatedCodes?.[0] ?? null,
    issuer: null,
    headline: h.headline ?? "(untitled SENS)",
    body: h.storyPreview ?? null,
    url: null,
    publishedAt: h.timestamp ?? new Date().toISOString(),
    ts: h.ts ?? 0,
    priority: "high",
    tickers: h.relatedCodes ?? [],
  }));
  const sens = [...sensFromIress, ...items.filter((n) => n.category.toUpperCase() === "SENS")];
  const wire = items.filter((n) => n.category.toUpperCase() !== "SENS");

  const all = items;
  const filtered = (tab === "all" ? all : tab === "sens" ? sens : wire).filter(
    (a) =>
      !q ||
      a.headline.toLowerCase().includes(q.toLowerCase()) ||
      a.source.toLowerCase().includes(q.toLowerCase()) ||
      a.tickers.some((t) => t.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <PageCanvas>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">News & SENS</h1>
          <p className="text-xs text-muted-foreground">Reuters · Bloomberg · Moneyweb · Dow Jones · SENS regulatory tape</p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="glass-inset h-auto gap-0.5 p-1">
              <TabsTrigger value="all" className={TAB_TRIGGER}>All · {all.length}</TabsTrigger>
              <TabsTrigger value="sens" className={TAB_TRIGGER}>SENS · {sens.length}</TabsTrigger>
              <TabsTrigger value="wire" className={TAB_TRIGGER}>Wires · {wire.length}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Headline, ticker, source…"
              className="glass-inset h-8 border-0 pl-8 text-xs shadow-none"
            />
          </div>
        </div>
      </header>

      <GlassSection
        title={`News tape · ${filtered.length} items`}
        db="retail"
        dataSource="external"
        endpoint="GET /api/news"
        noPadding
        className="flex h-[calc(100vh-220px)] min-h-0 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
          {newsQ.isLoading ? (
            <div className="glass-inset space-y-1.5 overflow-hidden px-4 py-3" aria-busy="true" aria-live="polite">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
                <div key={`news-item-${n}`} className="space-y-1.5 border-b border-[hsl(var(--glass-border))] pb-3 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="shimmer h-3 w-12 rounded" />
                    <span className="shimmer h-3 w-10 rounded" />
                    <span className="ml-auto shimmer h-3 w-10 rounded" />
                  </div>
                  <span className="shimmer block h-3 w-3/4 rounded" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyDataState
              message="No news items ingested."
              hint={newsQ.data?.message ?? "SENS requires the JSE SENS Web Feed subscription. Wires require Reuters / Bloomberg / Moneyweb contracts."}
              badgeLabel="blocked-vendor"
            />
          ) : (
            <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))] overflow-hidden">
              {filtered.map((a) => {
                const isSens = a.category.toUpperCase() === "SENS";
                return (
                  <li key={a.id} className="px-4 py-3 transition-colors hover:bg-[hsl(var(--primary)/0.06)]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={isSens ? "primary" : "info"} size="xs">
                      {isSens ? "SENS" : a.source}
                    </Pill>
                    {a.category && a.category.toUpperCase() !== "SENS" ? (
                      <Pill tone="neutral" size="xs">
                        {a.category}
                      </Pill>
                    ) : null}
                    {a.tickers.map((t) => (
                      <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
                        {t}
                      </span>
                    ))}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{formatTime(a.ts)}</span>
                  </div>
                  {(() => {
                    const headlineClass = cn(
                      "mt-1 text-[13px] leading-snug",
                      a.severity === "high" || a.severity === "regulatory" ? "font-semibold" : "font-medium",
                    );
                    if (a.url) {
                      // RSS / web article → open the source in a new tab.
                      return (
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(headlineClass, "block hover:text-primary hover:underline")}
                        >
                          {a.headline} <span className="text-[10px] text-muted-foreground">↗</span>
                        </a>
                      );
                    }
                    if (a.body) {
                      // Alliance wire (no external URL) → expand the body in-app.
                      const isOpen = expanded.has(a.id);
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleExpanded(a.id)}
                            className={cn(headlineClass, "block w-full text-left hover:text-primary")}
                            aria-expanded={isOpen}
                          >
                            {a.headline}{" "}
                            <span className="text-[10px] font-normal text-muted-foreground">{isOpen ? "▲ less" : "▾ read"}</span>
                          </button>
                          {isOpen ? (
                            <p className="mt-1.5 whitespace-pre-line text-[11.5px] leading-relaxed text-muted-foreground">
                              {a.body}
                            </p>
                          ) : null}
                        </>
                      );
                    }
                    return <p className={headlineClass}>{a.headline}</p>;
                  })()}
                </li>
              );
              })}
            </ul>
          )}
        </div>
      </GlassSection>

      <div className="glass-inset border-info/30 bg-info/5 p-3 text-[11.5px] text-info">
        <p className="flex items-center gap-2 font-semibold">
          <AlertCircle className="h-3.5 w-3.5" />
          News tape = Alliance News wire (live) + SENS (pending)
        </p>
        <p className="mt-1 text-muted-foreground">
          The wire tape reads the <span className="font-mono">News_articles</span> feed (Alliance News) from the retail DB — live. The <span className="font-mono">SENS</span> tab is the JSE regulatory announcement tape, which needs a separate JSE SENS Web Feed subscription, so it stays empty until that lands.
        </p>
      </div>
    </PageCanvas>
  );
}
