"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Send, ShieldAlert, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/admin/context";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * RebalanceBuilder — Phase B1 Rebalance Builder tab.
 *
 * Lists IC-approved notes (status='approved') and exposes the
 * affected-investor preview plus the gated "Push to rebalance" button.
 * The push hits `/api/rebalance/requests` (status='ic_approved') and
 * redirects to `/oems/rebalance/approved?request_id=...` once the row
 * lands. The "anyone can rebalance" risk is closed here: only
 * status='approved' notes show up.
 */

interface ApprovedNoteRow {
  id: string;
  symbol: string;
  author_email: string;
  status: string;
  thesis: unknown;
  approved_at: string | null;
}

interface AffectedInvestor {
  user_id: string;
  name: string;
  email: string | null;
  shares: number;
  exposure_cents: number;
  exposure_pct: number;
  basket_value_cents: number;
  as_of_date: string | null;
  strategies: string[];
  proposed_changes: Array<{
    symbol: string | null;
    action: string | null;
    shares: number | null;
    weight: number | null;
  }>;
}

interface RebalanceRequestPayload {
  strategy_id: string;
  current_composition: unknown[];
  proposed_composition: unknown[];
  affected_investors?: unknown[];
  research_note_id: string;
  status: "ic_approved";
}

function asThesis(input: unknown): { proposed_composition?: unknown[]; rating?: string; rationale?: string } {
  const t = (input ?? {}) as { proposed_composition?: unknown[]; rating?: string; rationale?: string };
  return {
    proposed_composition: Array.isArray(t.proposed_composition) ? t.proposed_composition : [],
    rating: typeof t.rating === "string" ? t.rating : undefined,
    rationale: typeof t.rationale === "string" ? t.rationale : undefined,
  };
}

export function RebalanceBuilder({ refreshKey }: { refreshKey?: string | number }) {
  const can = useCan();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const listQ = useQuery<{ ok: boolean; notes: ApprovedNoteRow[]; notice?: string }>({
    queryKey: ["bff-rebalance-approved", refreshKey],
    queryFn: async () => {
      const r = await fetch("/api/research/notes?status=approved", { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });

  const notes = listQ.data?.notes ?? [];

  React.useEffect(() => {
    const first = notes[0];
    if (!selectedId && first) setSelectedId(first.id);
    if (selectedId && !notes.find((n) => n.id === selectedId)) {
      setSelectedId(first?.id ?? null);
    }
  }, [notes, selectedId]);

  const impactQ = useQuery<{ ok: boolean; affected: AffectedInvestor[]; notice?: string }>({
    queryKey: ["bff-investor-impact", selectedId],
    queryFn: async () => {
      const r = await fetch(`/api/research/notes/${selectedId}/investor-impact`, { cache: "no-store" });
      return r.json();
    },
    enabled: Boolean(selectedId),
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  const note = notes.find((n) => n.id === selectedId) ?? null;
  const affected = impactQ.data?.affected ?? [];
  const thesis = note ? asThesis(note.thesis) : { proposed_composition: [] };

  const totalExposure = affected.reduce((s, a) => s + a.exposure_cents, 0);
  const totalBasket = affected.reduce((s, a) => s + a.basket_value_cents, 0);

  const pushRebalance = async () => {
    if (!note) return;
    if (!can("rebalance", "push_rebalance")) {
      toast.error("Insufficient permission to push a rebalance");
      return;
    }
    setBusy(true);
    try {
      const payload: RebalanceRequestPayload = {
        strategy_id: note.symbol,
        current_composition: [],
        proposed_composition: (thesis.proposed_composition as unknown[]) ?? [],
        research_note_id: note.id,
        status: "ic_approved",
        affected_investors: affected.map((a) => ({
          user_id: a.user_id,
          shares: a.shares,
          exposure_cents: a.exposure_cents,
          exposure_pct: a.exposure_pct,
        })),
      };
      const r = await fetch("/api/rebalance/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d?.error ?? "Could not raise rebalance request");
        return;
      }
      const reqId = d.request?.id ?? d.id;
      toast.success("Rebalance request raised · redirecting");
      void queryClient.invalidateQueries({ queryKey: ["bff-rebalance-approved"] });
      void queryClient.invalidateQueries({ queryKey: ["bff-action-items"] });
      router.push(`/oems/rebalance/approved?request_id=${reqId}` as never);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <GlassSection
        title="Approved notes"
        subtitle="Only IC-approved notes are eligible to push"
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
            title="No approved rebalances"
            message="Once the IC approves a note, it shows up here."
            hint={listQ.data?.notice}
          />
        ) : (
          <ul className="divide-y divide-[hsl(var(--glass-border))]">
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(n.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 px-3 py-2.5 text-left text-sm transition-colors",
                    selectedId === n.id ? "bg-primary/10" : "hover:bg-[hsl(var(--primary)/0.05)]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{n.symbol || "(no symbol)"}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {n.approved_at
                        ? new Date(n.approved_at).toLocaleDateString("en-ZA", {
                            day: "2-digit",
                            month: "short",
                          })
                        : "—"}
                    </Badge>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{n.author_email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </GlassSection>

      {note ? (
        <div className="space-y-4">
          <GlassSection
            title={`${note.symbol} · Rebalance builder`}
            subtitle={`Approved ${note.approved_at ? new Date(note.approved_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }) : "—"}`}
            endpoint="GET /api/research/notes/[id]/investor-impact"
            db="institutional"
            dataSource={impactQ.data?.notice ? "unavailable" : "supabase"}
            right={
              <Button
                size="sm"
                onClick={() => void pushRebalance()}
                disabled={busy || !can("rebalance", "push_rebalance")}
                className="gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                {busy ? "Pushing…" : "Push to rebalance"}
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <GlassKpi label="Affected investors" value={String(affected.length)} accent="primary" />
              <GlassKpi
                label="Aggregate exposure"
                value={totalExposure > 0 ? formatZARExact(totalExposure / 100) : "—"}
              />
              <GlassKpi
                label="Aggregate basket"
                value={totalBasket > 0 ? formatZARExact(totalBasket / 100) : "—"}
              />
              <GlassKpi label="Proposed moves" value={String((thesis.proposed_composition ?? []).length)} />
            </div>
            {!can("rebalance", "push_rebalance") ? (
              <p className="mt-3 flex items-center gap-1.5 text-[10px] italic text-muted-foreground">
                <ShieldAlert className="h-3 w-3" />
                Push to rebalance gated on the `rebalance/push_rebalance` permission.
              </p>
            ) : null}
          </GlassSection>

          <GlassSection
            title="Affected investors · preview"
            subtitle="Read-only simulation · no execution commits"
            endpoint="GET /api/research/notes/[id]/investor-impact"
            db="retail"
            dataSource={impactQ.data?.notice ? "unavailable" : "supabase"}
            right={
              <GlassBadge tone={affected.length === 0 ? "neutral" : "primary"}>
                {affected.length} investor{affected.length === 1 ? "" : "s"}
              </GlassBadge>
            }
          >
            {impactQ.isLoading ? (
              <PanelSkeleton rows={4} />
            ) : affected.length === 0 ? (
              <EmptyDataState
                title="No affected investors"
                message="No clients currently hold this symbol."
                hint="The note is approved but no clients have exposure — safe to skip the rebalance."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-[hsl(var(--glass-border))]">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
                      {["Investor", "Email", "Shares", "Exposure", "% of basket", "As of"].map((c) => (
                        <th
                          key={c}
                          className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {affected.slice(0, 50).map((a) => (
                      <tr
                        key={a.user_id}
                        className="border-b border-[hsl(var(--glass-border))]/40 last:border-b-0"
                      >
                        <td className="px-3 py-2 text-xs font-semibold">{a.name}</td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">{a.email ?? "—"}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{a.shares}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {formatZARExact(a.exposure_cents / 100)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {a.exposure_pct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">{a.as_of_date ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {affected.length > 50 ? (
                  <p className="border-t border-[hsl(var(--glass-border))] px-3 py-2 text-[10px] italic text-muted-foreground">
                    Showing first 50 of {affected.length} affected investors.
                  </p>
                ) : null}
              </div>
            )}
          </GlassSection>

          <GlassSection
            title="Composition · current vs proposed"
            subtitle="Synthetic baseline · the full basket comes from /api/research-lab (BFF read)"
            endpoint="GET /api/research/notes/[id]/ic-summary"
            db="institutional"
            dataSource="supabase"
          >
            <CompositionDiff note={note} thesis={thesis} />
          </GlassSection>
        </div>
      ) : (
        <GlassSection title="Note" db="institutional" dataSource="unavailable">
          <EmptyDataState
            title="No approved note selected"
            message="Pick an IC-approved note from the list to begin the rebalance."
          />
        </GlassSection>
      )}
    </div>
  );
}

function CompositionDiff({
  note,
  thesis,
}: {
  note: ApprovedNoteRow;
  thesis: { proposed_composition?: unknown[] };
}) {
  const proposed = (
    (thesis.proposed_composition ?? []) as Array<{
      symbol?: string;
      action?: string;
      shares?: number;
      weight?: number;
    }>
  ).map((p, idx) => ({
    symbol: p.symbol ?? `ROW-${idx}`,
    action: p.action ?? "hold",
    shares: typeof p.shares === "number" ? p.shares : 0,
    weight: typeof p.weight === "number" ? p.weight : null,
  }));
  if (proposed.length === 0) {
    return (
      <p className="py-6 text-center text-xs italic text-muted-foreground">
        Thesis-only note — no proposed composition.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className="glass-inset p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Current
        </p>
        <p className="text-xs text-muted-foreground">
          Read from the legacy research-lab basket (caller-supplied). The Rebalance Builder shows the diff
          against the note's proposal.
        </p>
      </div>
      <div className="glass-inset p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Proposed
        </p>
        <ul className="space-y-1 text-xs">
          {proposed.map((p, idx) => (
            <li key={`${p.symbol}-${idx}`} className="flex items-center gap-2">
              <Badge
                variant={
                  p.action === "add" || p.action === "increase"
                    ? "default"
                    : p.action === "remove" || p.action === "decrease"
                      ? "destructive"
                      : "outline"
                }
              >
                {p.action}
              </Badge>
              <span className="font-mono">{p.symbol}</span>
              <span className="text-muted-foreground">{p.shares} sh</span>
              {p.weight != null ? (
                <span className="text-muted-foreground">· {(p.weight * 100).toFixed(1)}%</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-center text-muted-foreground md:col-span-2">
        <ArrowRight className="h-4 w-4" />
      </div>
    </div>
  );
}
