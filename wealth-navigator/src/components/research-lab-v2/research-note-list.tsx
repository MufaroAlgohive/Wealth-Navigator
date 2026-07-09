"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ClipboardList } from "lucide-react";
import * as React from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassSection } from "@/components/oems/primitives/glass";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * ResearchNoteList — read-only list of notes filtered by status. The
 * Research tab uses this with status="draft" + "in_review" to surface the
 * analyst's own work in flight; the IC tab uses status="ic_pending"; the
 * Approved tab uses status="approved". Clicking a row calls `onSelect`.
 */

export interface ResearchNoteRow {
  id: string;
  symbol: string;
  author_email: string;
  status: string;
  thesis: unknown;
  triggers: unknown | null;
  valuation: unknown | null;
  ic_session_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

const STATUS_TONE: Record<string, "neutral" | "primary" | "success"> = {
  draft: "neutral",
  in_review: "primary",
  ic_pending: "primary",
  approved: "success",
  rejected: "neutral",
  executed: "success",
};

const STATUS_OPTIONS = ["draft", "in_review", "ic_pending", "approved", "rejected"] as const;

export function ResearchNoteList({
  status,
  title = "Notes",
  emptyMessage,
  onSelect,
  selectedId,
  showStatusFilter = false,
  refreshKey,
}: {
  status?: (typeof STATUS_OPTIONS)[number] | "draft" | "in_review";
  title?: string;
  emptyMessage?: string;
  onSelect?: (note: ResearchNoteRow) => void;
  selectedId?: string;
  showStatusFilter?: boolean;
  refreshKey?: string | number;
}) {
  const [statusFilter, setStatusFilter] = React.useState<string>(status ?? "all");
  const effectiveStatus = showStatusFilter ? statusFilter : status;

  const q = useQuery<{
    ok: boolean;
    notes: ResearchNoteRow[];
    notice?: string;
  }>({
    queryKey: ["bff-research-notes", effectiveStatus, refreshKey],
    queryFn: async () => {
      const url =
        effectiveStatus && effectiveStatus !== "all"
          ? `/api/research/notes?status=${encodeURIComponent(effectiveStatus)}`
          : "/api/research/notes";
      const r = await fetch(url, { cache: "no-store" });
      const data = await r.json();
      return data ?? { ok: false, notes: [] };
    },
    ...queryOpts("reference"),
  });

  const notes = q.data?.notes ?? [];

  return (
    <GlassSection
      title={title}
      endpoint="GET /api/research/notes"
      db="institutional"
      dataSource={notes.length > 0 ? "supabase" : "unavailable"}
      right={
        showStatusFilter ? (
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="glass-inset h-8 w-[140px] border-0">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      {q.isLoading ? (
        <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
      ) : notes.length === 0 ? (
        <EmptyDataState
          title="No notes in this bucket"
          message={emptyMessage ?? "No research notes match this filter."}
          hint={q.data?.notice}
          badgeLabel="unconfigured"
        />
      ) : (
        <ul className="divide-y divide-[hsl(var(--glass-border))]">
          {notes.map((n) => {
            const selected = selectedId === n.id;
            const tone = STATUS_TONE[n.status] ?? "neutral";
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onSelect?.(n)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors",
                    selected ? "bg-primary/10" : "hover:bg-[hsl(var(--primary)/0.05)]",
                  )}
                >
                  <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{n.symbol || "(no symbol)"}</span>
                      <GlassBadge tone={tone}>{n.status}</GlassBadge>
                      {n.ic_session_id ? (
                        <Badge variant="outline" className="text-[10px]">
                          IC session linked
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {n.author_email} · updated{" "}
                      {new Date(n.updated_at).toLocaleString("en-ZA", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                  {onSelect ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </GlassSection>
  );
}
