"use client";

import { useMemo, useState } from "react";

import type { DbName } from "@/components/oems/primitives/data-source-badge";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { NewsArticleDialog } from "@/components/oems/primitives/news-article-dialog";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { newsWireLabel, type NewsWire } from "@/lib/news-source";

/**
 * Normalised headline used by the Cockpit news flow. Both the seed feed
 * (`NewsItem` / `SensItem`) and the live BFF (`/api/news`) are mapped onto this
 * single shape by the caller so the panel renders one consistent list.
 *
 *  - `wire`     — "ALLIANCE" (general newswire: Reuters/Bloomberg/Moneyweb/…)
 *                 vs "SENS" (JSE regulatory announcements). Drives the toggle.
 *  - `body`     — full item text for the click-to-expand popup. Often the same
 *                 as the headline today (the wire only gives a headline); the
 *                 fuller article body wires in the data phase.
 *  - `url`      — external link for the popup, when the source provides one.
 */
export interface NewsFlowItem {
  id: string;
  headline: string;
  ts: number;
  /** Display source label, e.g. "Reuters", "SENS", "Naspers Ltd". */
  source: string;
  wire: NewsWire;
  category?: string;
  tickers?: string[];
  body?: string | null;
  url?: string | null;
  /** SENS regulatory flag — renders a REG pill. */
  regulatory?: boolean;
}

type SourceFilter = "ALL" | "ALLIANCE" | "MONEYWEB" | "SENS";

const SOURCE_TABS: ReadonlyArray<{ key: SourceFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "ALLIANCE", label: "Alliance" },
  { key: "MONEYWEB", label: "Moneyweb" },
  { key: "SENS", label: "SENS" },
];

/**
 * News Flow — sourced from BOTH the Alliance newswire and JSE SENS, with a
 * source toggle (All / Alliance / SENS) and click-to-expand popups (Dialog)
 * that show the full item. Implements Lonwabo's Cockpit news feedback.
 *
 * The caller passes a merged, pre-sorted `items` list (seed in mock mode, the
 * `/api/news` BFF in real-data mode). The toggle filters by `wire`. When the
 * filtered list is empty the panel shows an honest empty state.
 */
export function CockpitNewsFlow({
  items,
  title = "News Flow",
  endpoint,
  dataSource,
  db,
  sourceLabel,
  emptyMessage,
  emptyHint,
  limit = 8,
  className,
}: {
  items: NewsFlowItem[];
  title?: string;
  endpoint: string;
  dataSource: "supabase" | "seed" | "unconfigured" | "unavailable" | "external";
  db?: DbName;
  sourceLabel?: string;
  emptyMessage?: string;
  emptyHint?: string;
  limit?: number;
  className?: string;
}) {
  const [filter, setFilter] = useState<SourceFilter>("ALL");
  const [active, setActive] = useState<NewsFlowItem | null>(null);

  const filtered = useMemo(() => {
    const rows = filter === "ALL" ? items : items.filter((i) => i.wire === filter);
    return rows.slice(0, limit);
  }, [items, filter, limit]);

  return (
    <>
      <GlassSection
        title={title}
        endpoint={endpoint}
        dataSource={dataSource}
        db={db}
        noPadding
        className={cn("flex h-[260px] flex-col min-h-0", className)}
        right={
          <div className="flex items-center gap-2">
            <div className="glass-inset inline-flex overflow-hidden p-0.5">
              {SOURCE_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setFilter(t.key)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                    filter === t.key
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {sourceLabel && <span className="text-caption font-mono">{sourceLabel}</span>}
          </div>
        }
      >
        {filtered.length === 0 ? (
          <div className="p-5">
            <EmptyDataState
              message={emptyMessage ?? "No news items right now."}
              hint={
                emptyHint ??
                "Sourced from the Alliance newswire + JSE SENS. The SENS toggle isolates regulatory announcements."
              }
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-5 pb-5">
            <ul className="divide-y divide-[hsl(var(--glass-border))]/60">
              {filtered.map((n) => (
                <li key={n.id} className="px-0 py-2.5">
                  <button
                    type="button"
                    onClick={() => setActive(n)}
                    className="flex w-full items-start gap-3 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium leading-snug">{n.headline}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
                        <span>{formatTime(n.ts)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <Pill tone={n.wire === "SENS" ? "primary" : "neutral"} size="xs">
                          {newsWireLabel(n.wire)}
                        </Pill>
                        <span className="text-muted-foreground/70">{n.source}</span>
                        {n.regulatory && (
                          <Pill tone="destructive" size="xs">
                            REG
                          </Pill>
                        )}
                        {(n.tickers ?? []).slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </GlassSection>

      <NewsArticleDialog item={active} open={active != null} onOpenChange={(o) => !o && setActive(null)} />
    </>
  );
}
