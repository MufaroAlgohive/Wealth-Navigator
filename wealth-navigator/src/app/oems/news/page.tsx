"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, AlertCircle } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
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

  if (!realDataOnly) {
    return (
      <div className="space-y-3">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">News & SENS</h1>
          <p className="text-xs text-muted-foreground">Reuters · Bloomberg · Moneyweb · Dow Jones · SENS regulatory tape</p>
        </header>
        <Panel title="News tape" endpoint="news_item_c">
          <EmptyDataState
            message="Mock mode disables the news module."
            hint="Switch to real-data mode and ensure the worker has written news_item_c rows."
            badgeLabel="mock"
          />
        </Panel>
      </div>
    );
  }

  const [tab, setTab] = useState<"all" | "sens" | "wire">("all");
  const [q, setQ] = useState("");

  // The BFF exposes one `news_item_c` table that holds both wires and SENS.
  // We bucket client-side by category — `category = "SENS"` is the SENS tape,
  // everything else is the wire / vendor feed.
  const sens = items.filter((n) => n.category.toUpperCase() === "SENS");
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
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">News & SENS</h1>
          <p className="text-xs text-muted-foreground">Reuters · Bloomberg · Moneyweb · Dow Jones · SENS regulatory tape</p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="h-8">
              <TabsTrigger value="all" className="h-6 px-3 text-[11px]">All · {all.length}</TabsTrigger>
              <TabsTrigger value="sens" className="h-6 px-3 text-[11px]">SENS · {sens.length}</TabsTrigger>
              <TabsTrigger value="wire" className="h-6 px-3 text-[11px]">Wires · {wire.length}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Headline, ticker, source…" className="h-8 pl-8 text-xs" />
          </div>
        </div>
      </header>

      <Panel
        title={`News tape · ${filtered.length} items`}
        endpoint="GET /api/news"
        dataSource={newsQ.data?.source === "supabase" ? "supabase" : "unconfigured"}
        density="scroll"
        className="h-[calc(100vh-220px)]"
      >
        {newsQ.isLoading ? (
          <div className="space-y-1.5 px-4 py-3" aria-busy="true" aria-live="polite">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
              <div key={`news-item-${n}`} className="space-y-1.5 border-b border-border/60 pb-3 last:border-0">
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
          <ul className="divide-y divide-border/60">
            {filtered.map((a) => {
              const isSens = a.category.toUpperCase() === "SENS";
              return (
                <li key={a.id} className="px-4 py-3 hover:bg-muted/30">
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
                  <p
                    className={cn(
                      "mt-1 text-[13px] leading-snug",
                      a.severity === "high" || a.severity === "regulatory" ? "font-semibold" : "font-medium",
                    )}
                  >
                    {a.headline}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="rounded-md border border-info/30 bg-info/5 p-3 text-[11.5px] text-info">
        <p className="flex items-center gap-2 font-semibold">
          <AlertCircle className="h-3.5 w-3.5" />
          News is vendor-tape + SENS
        </p>
        <p className="mt-1 text-muted-foreground">
          The news BFF reads <span className="font-mono">news_item_c</span> — one row per wire or SENS item. v1 has no contracted vendor, so the tape renders the honest <span className="font-mono">BLOCKED-VENDOR</span> state. SENS is the JSE regulatory announcement tape.
        </p>
      </div>
    </div>
  );
}
