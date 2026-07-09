"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/admin/context";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * ApprovedNotesView — Phase B1 Approved tab.
 *
 * Read-only summary of approved notes. Each card surfaces the author, the
 * approval timestamp, and a "Push to rebalance" button that re-routes the
 * operator to the Rebalance Builder tab (so the affected-investor preview
 * stays in one place).
 */

interface ApprovedNoteRow {
  id: string;
  symbol: string;
  author_email: string;
  status: string;
  thesis: unknown;
  approved_at: string | null;
  updated_at: string;
}

export function ApprovedNotesView({ refreshKey }: { refreshKey?: string | number }) {
  const can = useCan();
  const queryClient = useQueryClient();
  const router = useRouter();

  const listQ = useQuery<{ ok: boolean; notes: ApprovedNoteRow[]; notice?: string }>({
    queryKey: ["bff-research-notes-approved", refreshKey],
    queryFn: async () => {
      const r = await fetch("/api/research/notes?status=approved", { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });

  const execQ = useQuery<{
    ok: boolean;
    requests: Array<{
      id: string;
      research_note_id?: string | null;
      executed_at: string | null;
      created_at: string;
    }>;
    notice?: string;
  }>({
    queryKey: ["bff-rebalance-requests-executed"],
    queryFn: async () => {
      const r = await fetch("/api/rebalance/requests?status=executed", { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  const notes = listQ.data?.notes ?? [];
  const executed = execQ.data?.requests ?? [];

  const lastExecutedByNote = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of executed) {
      if (r.executed_at) m.set(r.research_note_id ?? "", r.executed_at);
    }
    return m;
  }, [executed]);

  const goPush = (id: string) => {
    if (!can("rebalance", "push_rebalance")) {
      toast.error("Insufficient permission to push a rebalance");
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["bff-research-notes"] });
    router.push(`/oems/research-lab?tab=rebalance&focus=${encodeURIComponent(id)}`);
  };

  return (
    <GlassSection
      title="Approved notes"
      subtitle="Read-only summary of IC-approved rebalances with their last-executed timestamp"
      endpoint="GET /api/research/notes?status=approved"
      db="institutional"
      dataSource={notes.length > 0 ? "supabase" : "unavailable"}
      right={
        <GlassBadge tone="success">
          <ShieldCheck className="h-3 w-3" />
          {notes.length}
        </GlassBadge>
      }
    >
      {listQ.isLoading ? (
        <PanelSkeleton rows={4} />
      ) : notes.length === 0 ? (
        <EmptyDataState
          title="No approved notes yet"
          message="Approved research notes appear here once the Investment Committee approves them."
          hint={listQ.data?.notice}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {notes.map((n) => {
            const last = lastExecutedByNote.get(n.id);
            return (
              <li key={n.id} className={cn("glass-inset flex flex-col gap-2 p-4")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-base font-semibold text-primary">
                    {n.symbol || "(no symbol)"}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
                    {n.status}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">{n.author_email}</p>
                <p className="text-[11px] text-muted-foreground">
                  Approved:{" "}
                  <span className="font-mono">
                    {n.approved_at
                      ? new Date(n.approved_at).toLocaleString("en-ZA", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "—"}
                  </span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Last executed:{" "}
                  <span className="font-mono">
                    {last
                      ? new Date(last).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })
                      : "—"}
                  </span>
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => goPush(n.id)}
                    disabled={!can("rebalance", "push_rebalance")}
                    className="gap-1.5"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Push to rebalance
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/oems/research-lab?tab=ic&focus=${encodeURIComponent(n.id)}`)}
                    className="gap-1.5"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View note
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </GlassSection>
  );
}
