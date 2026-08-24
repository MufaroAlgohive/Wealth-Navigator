"use client";

import { ExternalLink } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pill } from "@/components/oems/primitives/pill";
import { formatTime } from "@/lib/format";
import { newsWireLabel, type NewsWire } from "@/lib/news-source";

/**
 * Canonical "full read" shape for the click-to-expand news popup shared by
 * all three news surfaces (the strategy news card, Cockpit news flow, and
 * the dedicated `/oems/news` tape). Every surface maps its own fetch shape
 * onto this before opening the dialog so there is one modal implementation.
 *
 * Honesty note: none of the underlying sources (`/api/news` RSS+wire+SENS
 * merge, `/api/iress/news` SENS passthrough) carry a full article body —
 * `body` is the fullest text the source gives us (a short RSS description,
 * the Alliance wire's `body_text`, or a SENS story preview/body). The modal
 * shows exactly that plus a link to the original source when one exists;
 * it does not fetch or fabricate additional article text.
 */
export interface NewsArticleDialogItem {
  headline: string;
  /** Fullest body text the source provides — may be a short snippet. */
  body?: string | null;
  source: string;
  /** Epoch ms, preferred when present. */
  ts?: number | null;
  /** ISO timestamp fallback when `ts` isn't available. */
  publishedAt?: string | null;
  url?: string | null;
  category?: string | null;
  tickers?: string[] | null;
  /** "ALLIANCE" | "SENS" — drives the wire pill when present. */
  wire?: NewsWire | null;
  regulatory?: boolean;
}

export function NewsArticleDialog({
  item,
  open,
  onOpenChange,
}: {
  item: NewsArticleDialogItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const when = item ? (item.ts != null ? formatTime(item.ts) : item.publishedAt ? formatTime(item.publishedAt) : null) : null;
  const tickers = item?.tickers ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {item && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-1.5">
                {item.wire && (
                  <Pill tone={item.wire === "SENS" ? "primary" : "neutral"} size="xs">
                    {newsWireLabel(item.wire)}
                  </Pill>
                )}
                {item.regulatory && (
                  <Pill tone="destructive" size="xs">
                    REG
                  </Pill>
                )}
                {item.category && (
                  <Pill tone="neutral" size="xs">
                    {item.category}
                  </Pill>
                )}
                {when && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{when}</span>}
              </div>
              <DialogTitle className="mt-2 pr-6 leading-snug">{item.headline}</DialogTitle>
              <DialogDescription className="font-mono text-[11px]">{item.source}</DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
                {item.body && item.body.trim().length > 0 ? item.body : item.headline}
              </p>

              {tickers.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {tickers.map((t) => (
                    <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {/* Honest gap: some feeds expose only a headline/link even when
                  the publisher's own page contains a full article. */}
              {(!item.body || item.body.trim().length === 0) && (
                <p className="text-[11px] text-muted-foreground">
                  {item.url
                    ? "This feed did not provide article text. Open the publisher’s page to read the available article."
                    : "This feed provided only the headline; no article text or publisher link is available."}
                </p>
              )}

              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  Open source
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
