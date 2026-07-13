"use client";

/**
 * Research Library — the institutional research surface. Left: the note library
 * with status filter chips + search. Right: the full note detail (thesis,
 * triggers, fundamentals, valuation, IC log) or the create/edit form. Backed by
 * /api/research/notes (institutional DB); CURRENT/UPSIDE are live.
 *
 * Library rows render the Lovable stock-card shape: ticker chip + company name,
 * in-strategy vs shortlist pill, analyst avatar, big rating, big upside stat
 * and status pill. Per Lonwabo's call-out (transcript 2026-07-13, L:1019)
 * "we must already tell if it's in a strategy or just a shortlisted name" — the
 * `thesis.linkedStrategies` array drives the In-Strategy badge; an empty array
 * shows a Shortlist badge so the analyst can see at a glance what the note is
 * bound to.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search } from "lucide-react";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import { NoteDetail } from "./note-detail";
import { NoteEditor } from "./note-editor";
import type { NoteStatus, ResearchNote, ResearchPerms } from "./types";
import {
  ConvictionBadge,
  RatingBadge,
  STATUS_FILTERS,
  StatusChip,
  initialsOf,
  moneyR,
  signedPct,
  useQuotes,
} from "./ui";

type Mode = { kind: "view" } | { kind: "edit"; note: ResearchNote } | { kind: "new" };

export function ResearchLibraryPage({
  perms,
  viewerEmail,
  viewerName,
}: {
  perms: ResearchPerms;
  viewerEmail: string | null;
  viewerName: string | null;
}) {
  const qc = useQueryClient();
  const notesQuery = useQuery<{ notes: ResearchNote[]; notice?: string }>({
    queryKey: ["ric-notes"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch("/api/research/notes", { cache: "no-store" });
      return (await res.json().catch(() => ({ notes: [] }))) as { notes: ResearchNote[]; notice?: string };
    },
  });
  const notes = notesQuery.data?.notes ?? [];

  const [filter, setFilter] = React.useState<"all" | NoteStatus>("all");
  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<Mode>({ kind: "view" });
  const [submitting, setSubmitting] = React.useState(false);

  const quotes = useQuotes(notes.map((n) => n.symbol));

  const filtered = notes.filter((n) => {
    if (filter !== "all" && n.status !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      n.symbol.toLowerCase().includes(q) ||
      (n.thesis?.companyName ?? "").toLowerCase().includes(q) ||
      (n.thesis?.linkedStrategies ?? []).some((s) => s.toLowerCase().includes(q))
    );
  });

  // Keep a valid selection.
  React.useEffect(() => {
    if (mode.kind !== "view") return;
    if (selectedId && notes.some((n) => n.id === selectedId)) return;
    setSelectedId(filtered[0]?.id ?? notes[0]?.id ?? null);
  }, [notes, filtered, selectedId, mode.kind]);

  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const approvedCount = notes.filter((n) => n.status === "approved").length;
  const inFlight = notes.filter((n) => n.status === "ic_pending" || n.status === "in_review").length;
  // Status-chip buckets with counts — drives the chip labels above the list.
  const counts = React.useMemo(() => {
    const c: Record<"all" | NoteStatus, number> = {
      all: notes.length,
      draft: 0,
      in_review: 0,
      ic_pending: 0,
      approved: 0,
      rejected: 0,
    };
    for (const n of notes) c[n.status] += 1;
    return c;
  }, [notes]);

  async function submitToIc(note: ResearchNote) {
    setSubmitting(true);
    try {
      // draft → in_review → ic_pending (author or dev).
      if (note.status === "draft") {
        await fetch(`/api/research/notes/${note.id}/transition`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to_status: "in_review" }),
        });
      }
      await fetch(`/api/research/notes/${note.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to_status: "ic_pending" }),
      });
      await qc.invalidateQueries({ queryKey: ["ric-notes"] });
    } finally {
      setSubmitting(false);
    }
  }

  function upsideFor(n: ResearchNote): number | null {
    const cur = quotes.data?.[n.symbol.toUpperCase()]?.last ?? null;
    const tgt = n.thesis?.targetPrice ?? null;
    return cur != null && tgt != null && cur > 0 ? ((tgt - cur) / cur) * 100 : null;
  }
  function currentFor(n: ResearchNote): number | null {
    return quotes.data?.[n.symbol.toUpperCase()]?.last ?? null;
  }

  return (
    <ResearchLabCanvas>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Research Library</h1>
          <p className="text-caption">
            Institutional-grade notes · thesis, valuation, triggers &amp; IC log for every position.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              <b className="text-foreground">{notes.length}</b> notes
            </span>
            <span>
              <b className="text-up">{approvedCount}</b> approved
            </span>
            <span>
              <b className="text-primary">{inFlight}</b> in flight
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            disabled={!perms.createNote}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> New Note
          </button>
        </div>
      </header>

      {notesQuery.data?.notice && (
        <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-500">
          {notesQuery.data.notice}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
        {/* library list */}
        <GlassSection
          title="Library"
          right={<span className="font-mono text-xs text-muted-foreground">{filtered.length}</span>}
        >
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Ticker, name, strategy…"
                className="w-full rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] py-2 pl-8 pr-3 text-sm outline-none focus:border-primary/50"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((f) => {
                const n = counts[f.id];
                const active = filter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                      active
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                    <span
                      className={cn(
                        "rounded px-1 text-[9px] tabular-nums",
                        active ? "bg-primary/15" : "bg-[hsl(var(--foreground)/0.05)]",
                      )}
                    >
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="max-h-[640px] space-y-2 overflow-y-auto pr-1">
              {notesQuery.isLoading && <p className="text-caption">Loading notes…</p>}
              {!notesQuery.isLoading && filtered.length === 0 && (
                <p className="text-caption">No notes match.</p>
              )}
              {filtered.map((n) => {
                const up = upsideFor(n);
                const cur = currentFor(n);
                const tgt = n.thesis?.targetPrice ?? null;
                const active = n.id === selectedId && mode.kind === "view";
                const linked = (n.thesis?.linkedStrategies ?? []).filter(Boolean);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(n.id);
                      setMode({ kind: "view" });
                    }}
                    className={cn(
                      "flex w-full items-stretch gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
                      active
                        ? "border-primary/45 bg-primary/8 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]"
                        : "border-transparent hover:border-[hsl(var(--glass-border))] hover:bg-[hsl(var(--foreground)/0.03)]",
                    )}
                  >
                    {/* ticker + company + analyst block */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-base font-semibold tracking-tight text-primary">
                          {n.symbol}
                        </span>
                        <RatingBadge rating={n.thesis?.rating} />
                        {n.thesis?.style && (
                          <span className="rounded-md border border-[hsl(var(--glass-border))] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {n.thesis.style}
                          </span>
                        )}
                        {n.thesis?.conviction && <ConvictionBadge conviction={n.thesis.conviction} />}
                      </div>
                      <p className="truncate text-xs font-medium text-foreground/85">
                        {n.thesis?.companyName ?? n.symbol}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span
                            aria-hidden
                            className="flex h-4 w-4 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.08)] text-[9px] font-semibold text-muted-foreground"
                          >
                            {initialsOf(n.thesis?.analystName ?? n.author_email)}
                          </span>
                          {n.thesis?.analystName ?? n.author_email.split("@")[0]}
                        </span>
                        {typeof n.thesis?.version === "number" && (
                          <span>· v{n.thesis.version}</span>
                        )}
                        {linked.length > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.08)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-up"
                            title={`In strategy: ${linked.join(", ")}`}
                          >
                            In strategy · {linked.length}
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.05)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
                            title="No strategy linkage yet — shortlist."
                          >
                            Shortlist
                          </span>
                        )}
                      </div>
                    </div>

                    {/* right block: status + stat */}
                    <div className="flex shrink-0 flex-col items-end justify-between text-right">
                      <StatusChip status={n.status} />
                      <div className="space-y-0.5">
                        {tgt != null && (
                          <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                            TP {moneyR(tgt, 0)}
                          </p>
                        )}
                        <p
                          className={cn(
                            "font-mono text-sm font-semibold tabular-nums",
                            up == null ? "text-muted-foreground" : up >= 0 ? "text-up" : "text-down",
                          )}
                        >
                          {cur != null ? moneyR(cur, 0) : quotes.isLoading ? "…" : "—"}
                        </p>
                        <p
                          className={cn(
                            "font-mono text-[11px] tabular-nums",
                            up == null ? "text-muted-foreground" : up >= 0 ? "text-up" : "text-down",
                          )}
                        >
                          {up == null ? (quotes.isLoading ? "…" : "—") : signedPct(up)}
                        </p>
                      </div>
                    </div>

                    <ChevronRight className="self-center text-muted-foreground h-4 w-4 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        </GlassSection>

        {/* detail / editor */}
        <div>
          {mode.kind === "new" && (
            <NoteEditor
              onSaved={async (id) => {
                await qc.invalidateQueries({ queryKey: ["ric-notes"] });
                setSelectedId(id);
                setMode({ kind: "view" });
              }}
              onCancel={() => setMode({ kind: "view" })}
            />
          )}
          {mode.kind === "edit" && (
            <NoteEditor
              note={mode.note}
              onSaved={async (id) => {
                await qc.invalidateQueries({ queryKey: ["ric-notes"] });
                setSelectedId(id);
                setMode({ kind: "view" });
              }}
              onCancel={() => setMode({ kind: "view" })}
            />
          )}
          {mode.kind === "view" &&
            (selected ? (
              <NoteDetail
                note={selected}
                perms={perms}
                busy={submitting}
                onEdit={() => setMode({ kind: "edit", note: selected })}
                onSubmitToIc={() => submitToIc(selected)}
              />
            ) : (
              <GlassSection title="Research note">
                <p className="text-caption">
                  {notes.length === 0
                    ? "No research notes yet. Create the first one with “New Note”."
                    : "Select a note from the library."}
                </p>
              </GlassSection>
            ))}
        </div>
      </div>
    </ResearchLabCanvas>
  );
}
