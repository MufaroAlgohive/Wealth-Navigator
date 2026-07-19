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

          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 z-[1] bg-[hsl(var(--background)/0.85)] backdrop-blur">
                <tr className="text-left text-[9px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">Symbol</th>
                  <th className="px-1.5 py-1.5 font-medium">Rating</th>
                  <th className="px-1.5 py-1.5 font-medium">Status</th>
                  <th className="px-1.5 py-1.5 text-right font-medium">Price</th>
                  <th className="px-1.5 py-1.5 text-right font-medium">Upside</th>
                  <th className="px-1.5 py-1.5 font-medium">Strategy</th>
                  <th className="px-2 py-1.5 font-medium">Analyst</th>
                </tr>
              </thead>
              <tbody>
                {notesQuery.isLoading && (
                  <tr>
                    <td colSpan={7} className="px-2 py-3 text-caption">
                      Loading notes…
                    </td>
                  </tr>
                )}
                {!notesQuery.isLoading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-2 py-3 text-caption">
                      No notes match.
                    </td>
                  </tr>
                )}
                {filtered.map((n) => {
                  const up = upsideFor(n);
                  const cur = currentFor(n);
                  const active = n.id === selectedId && mode.kind === "view";
                  const linked = (n.thesis?.linkedStrategies ?? []).filter(Boolean);
                  const analyst =
                    n.thesis?.analystName ?? n.author_email.split("@")[0] ?? "—";
                  return (
                    <tr
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedId(n.id);
                        setMode({ kind: "view" });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedId(n.id);
                          setMode({ kind: "view" });
                        }
                      }}
                      title={`${n.symbol} · ${n.thesis?.companyName ?? ""}`}
                      className={cn(
                        "cursor-pointer border-b border-[hsl(var(--glass-border)/0.5)] transition-colors last:border-b-0",
                        active
                          ? "bg-primary/10"
                          : "hover:bg-[hsl(var(--foreground)/0.04)]",
                      )}
                    >
                      <td className="px-2 py-1 align-middle">
                        <div className="flex min-w-0 items-baseline gap-1">
                          <span className="truncate font-mono text-[11px] font-semibold text-primary">
                            {n.symbol}
                          </span>
                          {n.thesis?.conviction && (
                            <ConvictionBadge conviction={n.thesis.conviction} />
                          )}
                        </div>
                      </td>
                      <td className="px-1.5 py-1 align-middle">
                        <RatingBadge rating={n.thesis?.rating} />
                      </td>
                      <td className="px-1.5 py-1 align-middle">
                        <StatusChip status={n.status} />
                      </td>
                      <td className="px-1.5 py-1 text-right align-middle font-mono tabular-nums">
                        {cur != null
                          ? moneyR(cur, 0)
                          : quotes.isLoading
                            ? <span className="text-muted-foreground">…</span>
                            : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td
                        className={cn(
                          "px-1.5 py-1 text-right align-middle font-mono tabular-nums",
                          up == null
                            ? "text-muted-foreground"
                            : up >= 0
                              ? "text-up"
                              : "text-down",
                        )}
                      >
                        {up == null
                          ? quotes.isLoading
                            ? "…"
                            : "—"
                          : signedPct(up)}
                      </td>
                      <td className="px-1.5 py-1 align-middle">
                        {linked.length > 0 ? (
                          <span
                            className="inline-flex max-w-full truncate rounded border border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.08)] px-1 text-[9px] font-semibold uppercase tracking-wide text-up"
                            title={`In strategy: ${linked.join(", ")}`}
                          >
                            {linked.length}
                          </span>
                        ) : (
                          <span
                            className="text-[9px] uppercase tracking-wide text-muted-foreground/70"
                            title="Shortlist — not yet in a strategy"
                          >
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 align-middle">
                        <div className="flex min-w-0 items-center gap-1">
                          <span
                            aria-hidden
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.08)] text-[8px] font-semibold uppercase text-muted-foreground"
                          >
                            {initialsOf(analyst)}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {analyst}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
