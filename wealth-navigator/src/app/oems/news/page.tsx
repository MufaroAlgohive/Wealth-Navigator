"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIress } from "@/lib/iress/provider";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

export default function NewsPage() {
  const { data } = useIress();
  const newsQ = useQuery({ queryKey: ["news"], queryFn: () => data.news(), ...queryOpts("reference") });
  const sensQ = useQuery({ queryKey: ["sens"], queryFn: () => data.sens(), ...queryOpts("reference") });
  const news = newsQ.data ?? [];
  const sens = sensQ.data ?? [];

  const [tab, setTab] = useState<"all" | "sens" | "wire">("all");
  const [q, setQ] = useState("");

  const all = [
    ...sens.map((s) => ({ kind: "sens" as const, ts: s.ts, headline: s.headline, tags: [s.category, s.ticker], source: s.issuer, severity: s.severity })),
    ...news.map((n) => ({ kind: "wire" as const, ts: n.ts, headline: n.headline, tags: [n.category, ...n.tickers], source: n.source, severity: n.priority })),
  ].sort((a, b) => b.ts - a.ts);

  const filtered = all
    .filter((a) => tab === "all" || (tab === "sens" ? a.kind === "sens" : a.kind === "wire"))
    .filter((a) => !q || a.headline.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.toLowerCase().includes(q.toLowerCase())));

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
              <TabsTrigger value="all"  className="h-6 px-3 text-[11px]">All · {all.length}</TabsTrigger>
              <TabsTrigger value="sens" className="h-6 px-3 text-[11px]">SENS · {sens.length}</TabsTrigger>
              <TabsTrigger value="wire" className="h-6 px-3 text-[11px]">Wires · {news.length}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Headline, ticker, source…" className="h-8 pl-8 text-xs" />
          </div>
        </div>
      </header>

      <Panel title={`News tape · ${filtered.length} items`} endpoint="GET /v1/news" density="scroll" className="h-[calc(100vh-220px)]">
        {newsQ.isLoading || sensQ.isLoading ? (
          <div className="space-y-1.5 px-4 py-3" aria-busy="true" aria-live="polite">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="space-y-1.5 border-b border-border/60 pb-3 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="shimmer h-3 w-12 rounded" />
                  <span className="shimmer h-3 w-10 rounded" />
                  <span className="ml-auto shimmer h-3 w-10 rounded" />
                </div>
                <span className="shimmer block h-3 w-3/4 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {filtered.map((a, i) => (
              <li key={i} className="px-4 py-3 hover:bg-muted/30">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill
                    tone={a.kind === "sens" ? "primary" : "info"}
                    size="xs"
                  >
                    {a.kind === "sens" ? "SENS" : a.source}
                  </Pill>
                  {a.tags.slice(0, 5).map((t) => (
                    <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">{t}</span>
                  ))}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{formatTime(a.ts)}</span>
                </div>
                <p className={cn("mt-1 text-[13px] leading-snug", a.severity === "high" || a.severity === "regulatory" ? "font-semibold" : "font-medium")}>
                  {a.headline}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
