"use client";

/**
 * Research Library — the institutional research surface. Left: the note library
 * with status filter chips + search. Right: the full note detail (thesis,
 * triggers, fundamentals, valuation, IC log) or the create/edit form. Backed by
 * /api/research/notes (institutional DB); CURRENT/UPSIDE are live.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search } from "lucide-react";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import { NoteDetail } from "./note-detail";
import { NoteEditor } from "./note-editor";
import type { NoteStatus, ResearchNote, ResearchPerms } from "./types";
import { RatingBadge, STATUS_FILTERS, StatusChip, signedPct, useQuotes } from "./ui";

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
    return n.symbol.toLowerCase().includes(q) || (n.thesis?.companyName ?? "").toLowerCase().includes(q);
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

      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
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
                placeholder="Ticker or name…"
                className="w-full rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] py-2 pl-8 pr-3 text-sm outline-none focus:border-primary/50"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                    filter === f.id
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="max-h-[620px] space-y-1.5 overflow-y-auto pr-1">
              {notesQuery.isLoading && <p className="text-caption">Loading notes…</p>}
              {!notesQuery.isLoading && filtered.length === 0 && (
                <p className="text-caption">No notes match.</p>
              )}
              {filtered.map((n) => {
                const up = upsideFor(n);
                const active = n.id === selectedId && mode.kind === "view";
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(n.id);
                      setMode({ kind: "view" });
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-primary/40 bg-primary/8"
                        : "border-transparent hover:border-[hsl(var(--glass-border))] hover:bg-[hsl(var(--foreground)/0.03)]",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold">{n.symbol}</span>
                        <RatingBadge rating={n.thesis?.rating} />
                      </div>
                      <p className="truncate text-caption">{n.thesis?.companyName ?? n.symbol}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusChip status={n.status} />
                      <span
                        className={cn(
                          "font-mono text-[11px] tabular-nums",
                          up == null ? "text-muted-foreground" : up >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {up == null ? "—" : signedPct(up)}
                      </span>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
