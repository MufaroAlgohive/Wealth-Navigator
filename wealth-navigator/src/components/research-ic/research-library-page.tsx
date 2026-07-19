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
import { Plus, Search } from "lucide-react";
import * as React from "react";

import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import { NoteDetail } from "./note-detail";
import { NoteEditor } from "./note-editor";
import type { NoteStatus, ResearchNote, ResearchPerms } from "./types";
import {
  ConvictionDot,
  RatingTag,
  STATUS_FILTERS,
  StatusDot,
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

  return (
    <ResearchLabCanvas className="space-y-3.5">
      <header className="flex flex-wrap items-end justify-between gap-2.5">
        <div className="space-y-0.5">
          <h1 className="text-lg font-semibold tracking-tight">Research Library</h1>
          <p className="text-caption">
            Institutional-grade notes · thesis, valuation, triggers &amp; IC log for every position.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
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
          <DataSourceBadge source="supabase" db="institutional" />
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            disabled={!perms.createNote}
            title={
              perms.createNote
                ? "Draft a new research note"
                : "Your role does not have create-note permission yet — ask an admin to grant research-lab/create_research_note."
            }
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3 w-3" /> New Note
          </button>
        </div>
      </header>

      {notesQuery.data?.notice && (
        <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-500">
          {notesQuery.data.notice}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
        {/* library list */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.015)]">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[hsl(var(--glass-border))] px-3 py-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Library
              <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                {filtered.length}
              </span>
              <DataSourceBadge source="hybrid" db="institutional" className="ml-2 align-middle" />
            </h2>
            <div className="flex items-center gap-1">
              {STATUS_FILTERS.map((f) => {
                const n = counts[f.id];
                const active = filter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    title={`${f.label} (${n})`}
                    className={cn(
                      "inline-flex h-5 min-w-[28px] items-center justify-center gap-1 rounded px-1.5 text-[9px] font-semibold uppercase tracking-wide transition-colors",
                      active
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)] hover:text-foreground",
                    )}
                  >
                    <span>{f.label}</span>
                    <span
                      className={cn(
                        "rounded px-1 text-[9px] tabular-nums",
                        active ? "bg-primary/30" : "bg-[hsl(var(--foreground)/0.05)]",
                      )}
                    >
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 px-3 py-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3 w-3 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ticker, name, strategy…"
                className="w-full rounded-md border border-transparent bg-[hsl(var(--foreground)/0.04)] py-1 pl-7 pr-2 text-[11px] outline-none focus:border-primary/40"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {notesQuery.isLoading && <p className="px-2 py-3 text-caption">Loading notes…</p>}
            {!notesQuery.isLoading && filtered.length === 0 && (
              <p className="px-2 py-3 text-caption">No notes match.</p>
            )}
            <div className="flex flex-col gap-0.5">
              {filtered.map((n) => {
                const up = upsideFor(n);
                const active = n.id === selectedId && mode.kind === "view";
                const linked = (n.thesis?.linkedStrategies ?? []).filter(Boolean);
                const name = n.thesis?.companyName ?? "";
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(n.id);
                      setMode({ kind: "view" });
                    }}
                    title={`${n.symbol} · ${name}${linked.length ? ` · in strategy: ${linked.join(", ")}` : ""}`}
                    className={cn(
                      "w-full rounded-md border-l-2 px-2.5 py-1.5 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/10"
                        : "border-transparent hover:bg-[hsl(var(--foreground)/0.04)]",
                    )}
                  >
                    {/* line 1 — ticker (+ conviction / in-strategy markers) · upside */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="font-mono text-[12px] font-semibold text-foreground">{n.symbol}</span>
                        {n.thesis?.conviction && <ConvictionDot conviction={n.thesis.conviction} />}
                        {linked.length > 0 && (
                          <span
                            aria-label={`In ${linked.length} strateg${linked.length === 1 ? "y" : "ies"}`}
                            className="text-[8px] text-up/80"
                          >
                            ◆
                          </span>
                        )}
                      </div>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[12px] font-semibold tabular-nums",
                          up == null ? "text-muted-foreground" : up >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {up == null ? (quotes.isLoading ? "…" : "—") : signedPct(up)}
                      </span>
                    </div>
                    {/* line 2 — company name (+ rating) · status */}
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[11px] text-muted-foreground">{name || "—"}</span>
                        <RatingTag rating={n.thesis?.rating} />
                      </div>
                      <StatusDot status={n.status} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

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
