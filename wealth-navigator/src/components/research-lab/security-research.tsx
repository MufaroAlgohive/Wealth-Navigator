"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, NotebookPen, Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/oems/primitives/pill";
import { GlassBadge } from "@/components/oems/primitives/glass";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { cn } from "@/lib/cn";
import type { Verdict } from "@/lib/research-lab/types";

/**
 * Item 7 — per-security research.
 * UI shell only: research lives in component state on the page and is keyed by
 * ticker. DB persistence (a `security_research` table surfaced as a desk-wide
 * wish list) is the data phase — see ResearchLabPage for the state owner.
 */
export interface SecurityResearch {
  ticker: string;
  name: string;
  rating: Verdict;
  notes: string;
  updatedAt: string;
}

const RATING_OPTIONS: Exclude<Verdict, null>[] = ["BUY", "HOLD", "SELL"];

function verdictTone(v: Verdict) {
  if (v === "BUY") return "success" as const;
  if (v === "SELL") return "destructive" as const;
  if (v === "HOLD") return "warning" as const;
  return "neutral" as const;
}

export function hasResearch(r: SecurityResearch | undefined): boolean {
  return Boolean(r && (r.rating != null || r.notes.trim().length > 0));
}

/** Small tick shown next to names that already have saved research. */
export function ResearchTick({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <CheckCircle2
      className="h-3.5 w-3.5 shrink-0 text-success"
      aria-label="Research on file"
    />
  );
}

interface SecurityResearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticker: string | null;
  name: string;
  existing: SecurityResearch | undefined;
  onSave: (research: SecurityResearch) => void;
}

/**
 * Clicking a security name opens this dialog showing the saved thesis/rating
 * and lets the analyst edit it. Save updates component state only for now.
 */
export function SecurityResearchDialog({
  open,
  onOpenChange,
  ticker,
  name,
  existing,
  onSave,
}: SecurityResearchDialogProps) {
  const [rating, setRating] = useState<Verdict>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setRating(existing?.rating ?? null);
    setNotes(existing?.notes ?? "");
  }, [open, existing]);

  if (!ticker) return null;

  function save() {
    if (!ticker) return;
    onSave({
      ticker,
      name,
      rating,
      notes: notes.trim(),
      updatedAt: new Date().toISOString(),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-panel max-h-[90vh] max-w-lg overflow-y-auto border-[hsl(var(--glass-border))] bg-[hsl(var(--card))] shadow-[0_24px_80px_hsl(var(--primary)/0.12)]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <NotebookPen className="h-5 w-5 text-primary" />
            <DialogTitle>
              <span className="font-mono text-primary">{ticker}</span> · research
            </DialogTitle>
          </div>
          <DialogDescription>
            {name}
            {existing ? (
              <span className="ml-2 text-caption">
                last updated{" "}
                {new Date(existing.updatedAt).toLocaleString("en-ZA", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-caption font-medium">Rating</p>
            <div className="flex gap-2">
              {RATING_OPTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRating((cur) => (cur === r ? null : r))}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors",
                    rating === r
                      ? r === "BUY"
                        ? "border-success/40 bg-success/15 text-success"
                        : r === "SELL"
                          ? "border-destructive/40 bg-destructive/15 text-destructive"
                          : "border-warning/40 bg-warning/15 text-warning"
                      : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="security-research-notes" className="text-caption font-medium">
              Thesis / notes
            </label>
            <textarea
              id="security-research-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why is this a buy/sell? Valuation, yield, sector view, catalysts, risks…"
              rows={6}
              className="glass-inset w-full resize-none rounded-xl border-0 bg-transparent px-3 py-2.5 text-sm shadow-none outline-none ring-1 ring-[hsl(var(--glass-border))] focus-visible:ring-primary"
            />
          </div>

          <p className="text-caption">
            Saved to this session only — research persists to a desk-wide{" "}
            <span className="font-mono">security_research</span> table in the data phase, so whoever
            adds this stock later can see the standing buy/sell view.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={rating == null && !notes.trim()}>
            Save research
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ResearchWishlistProps {
  research: SecurityResearch[];
  onOpen: (ticker: string, name: string) => void;
}

/**
 * Desk-wide shortlist / "wish list" of every security that has research on
 * file, with its standing buy/sell rating. Clicking a row reopens the thesis.
 */
export function ResearchWishlist({ research, onOpen }: ResearchWishlistProps) {
  const items = research.filter(hasResearch).sort((a, b) => (a.ticker < b.ticker ? -1 : 1));

  if (items.length === 0) {
    return (
      <EmptyDataState
        message="No research on file yet."
        hint="Click any holding name to capture a thesis and buy/sell rating. It surfaces here as the desk shortlist."
        badgeLabel="code-gap"
      />
    );
  }

  const buys = items.filter((r) => r.rating === "BUY").length;
  const sells = items.filter((r) => r.rating === "SELL").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <GlassBadge tone="primary">
          <Star className="h-3 w-3" />
          {items.length} on shortlist
        </GlassBadge>
        {buys > 0 && <Pill tone="success" size="xs">{buys} buy</Pill>}
        {sells > 0 && <Pill tone="destructive" size="xs">{sells} sell</Pill>}
      </div>
      <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))] overflow-hidden">
        {items.map((r) => (
          <li key={r.ticker}>
            <button
              type="button"
              onClick={() => onOpen(r.ticker, r.name)}
              className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--primary)/0.05)]"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-primary">{r.ticker}</span>
                  <ResearchTick active />
                  {r.rating && (
                    <Pill tone={verdictTone(r.rating)} size="xs">
                      {r.rating}
                    </Pill>
                  )}
                </div>
                {r.notes && (
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {r.notes}
                  </p>
                )}
              </div>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {new Date(r.updatedAt).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
