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

/**
 * Headlines that match this pattern are IRESS CT/prod-side fixture content,
 * not real regulatory announcements. IRESS publishes "Test Announcement N"
 * rows on the SENSD feed during integration testing; the prod seat picked
 * some up on 2026-07-22. Filter at the UI layer so the operator never sees
 * them — see `wealth-navigator/docs/ISSUES_LOG.md` §0.5.4 for context.
 */
const IRESS_FIXTURE_HEADLINE = /^Test Announcement(\s|$|[:\-–—])/i;

/**
 * Decode the small set of HTML entities IRESS returns inside `HeadlineText`
 * (e.g. `&#x2013;` for en-dash, `&#x2014;` for em-dash, `&amp;`, `&lt;`,
 * `&gt;`, `&quot;`, `&#39;`). Done at the UI layer so the source-of-truth
 * parser still stores the raw text — the entity stripping is a display
 * concern only. Mirrors what the alliance wire feed does server-side.
 */
function decodeIressHeadlineEntities(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/&#x2013;|&#8211;/g, "–")
    .replace(/&#x2014;|&#8212;/g, "—")
    .replace(/&#x2018;|&#8216;/g, "\u2018")
    .replace(/&#x2019;|&#8217;/g, "\u2019")
    .replace(/&#x201C;|&#8220;/g, "\u201C")
    .replace(/&#x201D;|&#8221;/g, "\u201D")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Pick the primary ticker for the row header. The IRESS `SecurityCodeList`
 * can contain 50+ bond codes (JSE bonds are prefixed `ZA…`) for a single
 * announcement; rendering all of them collapses the row. Prefer the first
 * equity-class code (no `ZA` prefix); fall back to the first code if every
 * code is a bond code. Returns `null` when the announcement has no codes.
 */
const MAX_VISIBLE_TICKERS = 5;
function pickPrimaryTicker(tickers: string[]): string | null {
  if (!tickers || tickers.length === 0) return null;
  const equity = tickers.find((t) => !/^ZA\d/i.test(t));
  if (equity !== undefined) return equity;
  const first = tickers[0];
  return first !== undefined ? first : null;
}

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

  // Persisted SENS rows from `news_item_c`. The worker writes here on
  // every loop tick (default 6h), so this is the durable source. The
  // IRESS prod passthrough (`/api/iress/news` below) is the live,
  // ephemeral mirror that always reflects "what's on the wire right
  // now"; both are merged into the SENS bucket so the UI stays
  // populated even when the Railway public proxy 502s.
  const sensDbQ = useQuery<NewsResponse>({
    queryKey: ["bff-news-sens-db"],
    queryFn: async () => {
      const r = await fetch("/api/news?category=SENS&limit=100", { cache: "no-store" });
      if (!r.ok) return { items: [], count: 0, source: "unconfigured" } as NewsResponse;
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  // JSE SENS announcements from the IRESS PROD feed (`NewsHeadlineGet`
  // passthrough, captured envelope 2026-07-20 — see
  // `wealth-navigator/docs/SENS_NEWSHEADLINE_WIRE.md`).
  //
  // The vendor code for this CT build is `SENSD` ("SENS NEWS DELAYED");
  // `SENS` (real-time) is not entitled yet. The probe returns real
  // announcements as long as the worker is on the prod market-data
  // session (default on Railway).
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
    dataRowCount?: number;
    error?: { code?: string; message?: string } | null;
  }>({
    queryKey: ["iress-sens"],
    queryFn: async () => {
      // Default the window to today's UTC trading day so the call never
      // gets a 0-row "no time anchor" reply; the operator can override via
      // ?dateFrom=YYYY-MM-DDTHH:MM:SS if they want an older day.
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const y = now.getUTCFullYear();
      const m = pad(now.getUTCMonth() + 1);
      const d = pad(now.getUTCDate());
      const dateFrom = `${y}-${m}-${d}T00:00:00`;
      const dateTo = `${y}-${m}-${d}T23:59:59`;
      const r = await fetch(
        `/api/iress/news?vendor=SENSD&pageSize=50&dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`,
        { cache: "no-store" },
      );
      if (!r.ok) return { ok: false, headlines: [], dataRowCount: 0, error: { code: "http_error", message: `HTTP ${r.status}` } };
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
        <GlassSection title="News tape" db="retail" dataSource="supabase" endpoint="GET /api/news">
          <EmptyDataState
            message="News ingest is offline. Try again once the worker is online."
            hint="Switch to live data via the IRESS worker (Railway) once online."
            badgeLabel="unconfigured"
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
  // Persisted SENS rows from `news_item_c`. These flow through the BFF
  // `/api/news?category=SENS` and are tagged `category="SENS"` by the
  // worker. They survive worker restarts and proxy outages, so they're
  // the durable backbone of the SENS tab. Live IRESS passthrough rows
  // (above) take priority on dedupe by id.
  const sensFromDb: NewsItem[] = (sensDbQ.data?.items ?? []).filter((n) => n.category.toUpperCase() === "SENS");
  const sens = [
    ...sensFromIress,
    ...items.filter((n) => n.category.toUpperCase() === "SENS"),
    ...sensFromDb,
  ];
  const wire = items.filter((n) => n.category.toUpperCase() !== "SENS");

  const all = items;
  // Strip IRESS-side fixture/test announcements BEFORE tab counts so the
  // badge reflects what's actually visible (e.g. "Test Announcement N"
  // rows on the SENSD feed during integration testing).
  const allClean = all.filter((a) => !IRESS_FIXTURE_HEADLINE.test(a.headline));
  const sensClean = sens.filter((a) => !IRESS_FIXTURE_HEADLINE.test(a.headline));
  const wireClean = wire.filter((a) => !IRESS_FIXTURE_HEADLINE.test(a.headline));
  const filtered = (tab === "all" ? allClean : tab === "sens" ? sensClean : wireClean).filter(
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
              <TabsTrigger value="all" className={TAB_TRIGGER}>All · {allClean.length}</TabsTrigger>
              <TabsTrigger value="sens" className={TAB_TRIGGER}>SENS · {sensClean.length}</TabsTrigger>
              <TabsTrigger value="wire" className={TAB_TRIGGER}>Wires · {wireClean.length}</TabsTrigger>
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
        // Tab-aware: All/Wires = external (RSS + Alliance wire); SENS = the IRESS
        // PROD news vendor (`NewsHeadlineGet` passthrough). When items flow
        // we label the source `iress`; when the entitlement is off or the
        // window has no rows we label `blocked-vendor` so the operator
        // sees the honest empty state.
        dataSource={tab === "sens" ? (sensClean.length > 0 ? "iress" : "blocked-vendor") : "external"}
        endpoint={tab === "sens" ? "GET /api/iress/news" : "GET /api/news"}
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
              hint={
                // Per-tab hint: SENS tab pulls from the IRESS prod market-data
                // session (`NewsHeadlineGet` vendor `SENSD`); the Wires tab
                // requires Alliance / Reuters / Bloomberg contracts.
                tab === "sens"
                  ? sens.length > sensClean.length
                    ? `IRESS returned ${sens.length - sensClean.length} test/fixture announcement(s) today — all filtered out. The SENSD vendor currently publishes "Test Announcement N" rows during integration. Headlines will populate when real announcements publish on the connected vendor.`
                    : "SENS reads live from `GET /api/iress/news` (worker `NewsHeadlineGet`, vendor `SENSD`). Empty usually means no announcements in the window — try a wider `dateFrom`/`dateTo`."
                  : "Wires require Reuters / Bloomberg / Moneyweb contracts."
              }
              badgeLabel={tab === "sens" ? "unconfigured" : "blocked-vendor"}
            />
          ) : (
            <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))] overflow-hidden">
              {filtered.map((a) => {
                const isSens = a.category.toUpperCase() === "SENS";
                // Pick the primary ticker for the row header; the IRESS
                // SecurityCodeList can carry 50+ bond codes (ZA-prefix) per
                // announcement, which collapses the row when rendered.
                const primaryTicker = pickPrimaryTicker(a.tickers);
                const overflowCount = Math.max(0, a.tickers.length - MAX_VISIBLE_TICKERS);
                const headlineText = decodeIressHeadlineEntities(a.headline);
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
                    {primaryTicker ? (
                      <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-foreground">
                        {primaryTicker}
                      </span>
                    ) : null}
                    {overflowCount > 0 ? (
                      <span
                        className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                        title={a.tickers.slice(MAX_VISIBLE_TICKERS).join(", ")}
                      >
                        +{overflowCount} more
                      </span>
                    ) : null}
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
                          {headlineText} <span className="text-[10px] text-muted-foreground">↗</span>
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
                            {headlineText}{" "}
                            <span className="text-[10px] font-normal text-muted-foreground">{isOpen ? "▲ less" : "▾ read"}</span>
                          </button>
                          {isOpen ? (
                            <p className="mt-1.5 whitespace-pre-line text-[11.5px] leading-relaxed text-muted-foreground">
                              {decodeIressHeadlineEntities(a.body ?? "")}
                            </p>
                          ) : null}
                        </>
                      );
                    }
                    return <p className={headlineClass}>{headlineText}</p>;
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
