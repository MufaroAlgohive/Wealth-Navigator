"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Send, ShieldCheck, ThumbsDown, ThumbsUp, Vote, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { BasketCompare } from "@/components/research-lab/basket-compare";
import { HoldingsTable } from "@/components/research-lab/holdings-table";
import { RemovableHoldingsTable } from "@/components/research-lab/removable-holdings-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCan } from "@/lib/admin/context";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * IcReviewView — Phase B1 Investment Committee tab.
 *
 * Shows the agenda list of ic_pending notes on the left; clicking one opens
 * the full note + side-by-side current vs proposed basket (re-using the
 * existing BasketCompare / HoldingsTable primitives) + voting sub-section
 * with live yes / no / abstain tally. Approval requires >= 2 yes votes
 * (configurable). The "Approve to Rebalance" button is gated by the
 * `research-lab/approve_note` granular permission; "Reject" is the same gate.
 */

interface VoteTally {
  yes: number;
  no: number;
  abstain: number;
  total: number;
}

interface VoteRow {
  id: string;
  note_id: string;
  voter_email: string;
  vote: "yes" | "no" | "abstain";
  rationale: string | null;
  voted_at: string;
}

interface ResearchNoteRow {
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

interface IcSummaryResponse {
  ok: boolean;
  summary: ResearchNoteRow | null;
  votes: VoteRow[];
  tally: VoteTally;
  notice?: string;
}

interface ProposedHolding {
  symbol?: string;
  ticker?: string;
  shares?: number;
  weight?: number;
  action?: "remove" | "decrease" | "increase" | "add" | "hold";
}

interface ThesisShape {
  bull?: string;
  bear?: string;
  rating?: "hold" | "accumulate" | "buy";
  rationale?: string;
  proposed_composition?: ProposedHolding[];
  key_ratios?: { label: string; value: string }[];
}

const QUORUM = 2;

function asThesis(
  input: unknown,
): Required<Pick<ThesisShape, "proposed_composition" | "key_ratios">> &
  Omit<ThesisShape, "proposed_composition" | "key_ratios"> {
  const t = (input ?? {}) as ThesisShape;
  return {
    bull: typeof t.bull === "string" ? t.bull : "",
    bear: typeof t.bear === "string" ? t.bear : "",
    rating: t.rating,
    rationale: typeof t.rationale === "string" ? t.rationale : "",
    proposed_composition: Array.isArray(t.proposed_composition) ? t.proposed_composition : [],
    key_ratios: Array.isArray(t.key_ratios) ? t.key_ratios : [],
  };
}

export function IcReviewView({
  refreshKey,
}: {
  refreshKey?: string | number;
}) {
  const can = useCan();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [rationale, setRationale] = React.useState("");
  const [busy, setBusy] = React.useState<null | "yes" | "no" | "abstain" | "approve" | "reject">(null);

  const listQ = useQuery<{ ok: boolean; notes: ResearchNoteRow[]; notice?: string }>({
    queryKey: ["bff-ic-agenda", refreshKey],
    queryFn: async () => {
      const r = await fetch("/api/research/notes?status=ic_pending", { cache: "no-store" });
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

  const summaryQ = useQuery<IcSummaryResponse>({
    queryKey: ["bff-ic-summary", selectedId],
    queryFn: async () => {
      const r = await fetch(`/api/research/notes/${selectedId}/ic-summary`, { cache: "no-store" });
      return r.json();
    },
    enabled: Boolean(selectedId),
    refetchInterval: 15_000,
    ...queryOpts("reference"),
  });

  const note = summaryQ.data?.summary ?? null;
  const tally = summaryQ.data?.tally ?? { yes: 0, no: 0, abstain: 0, total: 0 };
  const votes = summaryQ.data?.votes ?? [];
  const thesis = asThesis(note?.thesis);

  const castVote = async (vote: "yes" | "no" | "abstain") => {
    if (!note) return;
    setBusy(vote);
    try {
      const r = await fetch(`/api/research/notes/${note.id}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote, rationale: rationale || null }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d?.error ?? "Vote failed");
        return;
      }
      toast.success(`Vote recorded: ${vote}`);
      setRationale("");
      void queryClient.invalidateQueries({ queryKey: ["bff-ic-summary", note.id] });
    } finally {
      setBusy(null);
    }
  };

  const transition = async (to: "approved" | "rejected") => {
    if (!note) return;
    setBusy(to === "approved" ? "approve" : "reject");
    try {
      const r = await fetch(`/api/research/notes/${note.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: to, reason: rationale || null }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d?.error ?? "Transition failed");
        return;
      }
      toast.success(to === "approved" ? "Approved · moved to Rebalance Builder" : "Rejected");
      void queryClient.invalidateQueries({ queryKey: ["bff-ic-agenda"] });
      void queryClient.invalidateQueries({ queryKey: ["bff-research-notes"] });
      void queryClient.invalidateQueries({ queryKey: ["bff-ic-summary", note.id] });
      setSelectedId(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <GlassSection
        title="IC agenda"
        subtitle="Notes awaiting committee decision"
        endpoint="GET /api/research/notes?status=ic_pending"
        db="institutional"
        dataSource={notes.length > 0 ? "supabase" : "unavailable"}
        right={
          <GlassBadge>
            <Vote className="h-3 w-3" />
            {notes.length}
          </GlassBadge>
        }
      >
        {listQ.isLoading ? (
          <PanelSkeleton rows={4} />
        ) : notes.length === 0 ? (
          <EmptyDataState
            title="Agenda clear"
            message="No notes awaiting IC decision."
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
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(n.updated_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
                    </span>
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
            title={`${note.symbol} · Investment Committee review`}
            subtitle={`Submitted by ${note.author_email} · ${new Date(note.submitted_at ?? note.updated_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}`}
            endpoint="GET /api/research/notes/[id]/ic-summary"
            db="institutional"
            dataSource={summaryQ.data?.notice ? "unavailable" : "supabase"}
            right={
              <div className="flex flex-wrap items-center gap-2">
                <GlassBadge tone="primary">{note.status}</GlassBadge>
                {thesis.rating ? <Badge variant="outline">{thesis.rating}</Badge> : null}
              </div>
            }
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <GlassKpi label="Votes cast" value={String(tally.total)} />
              <GlassKpi label="Yes" value={String(tally.yes)} accent="positive" />
              <GlassKpi label="No" value={String(tally.no)} accent={tally.no > 0 ? "negative" : "default"} />
              <GlassKpi label="Abstain" value={String(tally.abstain)} />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Bull thesis
                </p>
                <p className="text-xs leading-relaxed">{thesis.bull || "—"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Bear thesis
                </p>
                <p className="text-xs leading-relaxed">{thesis.bear || "—"}</p>
              </div>
              <div className="space-y-1 md:col-span-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Rationale
                </p>
                <p className="text-xs leading-relaxed">{thesis.rationale || "—"}</p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Proposed composition changes
              </p>
              {thesis.proposed_composition.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                  No proposed composition attached — only thesis / triggers are under review.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {thesis.proposed_composition.map((p, idx) => (
                    <li
                      key={`${p.symbol ?? p.ticker ?? "row"}-${idx}`}
                      className="glass-inset flex flex-wrap items-center gap-2 px-2.5 py-1.5"
                    >
                      <Badge
                        variant={
                          p.action === "add" || p.action === "increase"
                            ? "default"
                            : p.action === "remove" || p.action === "decrease"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {p.action ?? "hold"}
                      </Badge>
                      <span className="font-mono font-semibold">{p.symbol ?? p.ticker ?? "—"}</span>
                      {typeof p.shares === "number" ? (
                        <span className="text-muted-foreground">{p.shares} shares</span>
                      ) : null}
                      {typeof p.weight === "number" ? (
                        <span className="text-muted-foreground">{(p.weight * 100).toFixed(1)}% weight</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </GlassSection>

          <ProposedBasketCompare note={note} thesis={thesis} />

          <GlassSection
            title="IC vote"
            subtitle={`Quorum ${QUORUM} yes votes required · cast via /api/research/notes/[id]/vote`}
            endpoint="POST /api/research/notes/[id]/vote"
            db="institutional"
            dataSource={summaryQ.data?.notice ? "unavailable" : "supabase"}
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {tally.yes >= QUORUM ? (
                  <GlassBadge tone="success">
                    <ShieldCheck className="h-3 w-3" />
                    Quorum reached
                  </GlassBadge>
                ) : (
                  <GlassBadge>
                    {tally.yes}/{QUORUM} yes
                  </GlassBadge>
                )}
                <span className="text-xs text-muted-foreground">
                  {tally.yes} yes · {tally.no} no · {tally.abstain} abstain
                </span>
              </div>
              <Input
                placeholder="Optional rationale…"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                className="glass-inset h-9 border-0"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void castVote("yes")}
                  disabled={busy !== null}
                  className="gap-1.5"
                >
                  <ThumbsUp className="h-3.5 w-3.5" />
                  Yes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void castVote("no")}
                  disabled={busy !== null}
                  className="gap-1.5"
                >
                  <ThumbsDown className="h-3.5 w-3.5" />
                  No
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void castVote("abstain")}
                  disabled={busy !== null}
                  className="gap-1.5"
                >
                  <Minus className="h-3.5 w-3.5" />
                  Abstain
                </Button>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void transition("approved")}
                    disabled={busy !== null || !can("research-lab", "approve_note") || tally.yes < QUORUM}
                    className="gap-1.5"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {busy === "approve" ? "Approving…" : "Approve to Rebalance"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void transition("rejected")}
                    disabled={busy !== null || !can("research-lab", "approve_note")}
                    className="gap-1.5"
                  >
                    <X className="h-3.5 w-3.5" />
                    {busy === "reject" ? "Rejecting…" : "Reject"}
                  </Button>
                </div>
              </div>
              {!can("research-lab", "approve_note") ? (
                <p className="text-[10px] italic text-muted-foreground">
                  Approve / Reject gated on the Research Lab · approve_note permission.
                </p>
              ) : null}
            </div>
            <div className="mt-4 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent votes
              </p>
              {votes.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">No votes yet.</p>
              ) : (
                <ul className="space-y-1">
                  {votes
                    .slice()
                    .reverse()
                    .map((v) => (
                      <li
                        key={v.id}
                        className="glass-inset flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-xs"
                      >
                        <Badge
                          variant={v.vote === "yes" ? "default" : v.vote === "no" ? "destructive" : "outline"}
                        >
                          {v.vote}
                        </Badge>
                        <span className="font-mono text-[11px] text-muted-foreground">{v.voter_email}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {new Date(v.voted_at).toLocaleString("en-ZA", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </span>
                        {v.rationale ? <span className="ml-2 italic">“{v.rationale}”</span> : null}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </GlassSection>
        </div>
      ) : listQ.isLoading ? (
        <PanelSkeleton rows={6} />
      ) : (
        <GlassSection title="Note" db="institutional" dataSource="unavailable">
          <EmptyDataState title="No note selected" message="Pick a note from the agenda to begin review." />
        </GlassSection>
      )}
    </div>
  );
}

function ProposedBasketCompare({
  note,
  thesis,
}: {
  note: ResearchNoteRow;
  thesis: ReturnType<typeof asThesis>;
}) {
  // Build a synthetic current vs proposed basket from the proposed_composition
  // diff. Without the legacy research-lab BFF we cannot render the full
  // composition (Live rows), so we surface a faithful diff instead.
  if (thesis.proposed_composition.length === 0) {
    return (
      <GlassSection
        title="Composition"
        subtitle="No proposed changes attached to this note"
        db="institutional"
        dataSource="supabase"
      >
        <p className="py-6 text-center text-xs italic text-muted-foreground">
          Composition diff is empty — this note is thesis-only.
        </p>
      </GlassSection>
    );
  }

  const proposed = thesis.proposed_composition.map((p, idx) => ({
    ticker: p.symbol ?? p.ticker ?? `${note.symbol || "ROW"}-${idx}`,
    name: p.symbol ?? p.ticker ?? "—",
    assetClass: "equity",
    sector: "Unknown",
    shares: typeof p.shares === "number" ? p.shares : 0,
    price: 0,
    value: 0,
    constWeight: 0,
    basketWeight: 0,
    rating: null,
    pending: false,
    priceSource: "unavailable" as const,
  }));

  // Mirror proposed on the "current" side so the diff is legible (current =
  // implied baseline with zero shares; proposed = what the note wants).
  const current = proposed.map((p) => ({ ...p, shares: 0 }));

  const totalsFor = (rows: typeof proposed) => {
    const constituent = rows.reduce((s, r) => s + r.shares, 0);
    return {
      constituent,
      cash: 0,
      cashPct: 0,
      basketMin: 0,
    };
  };

  return (
    <GlassSection
      title="Composition · current vs proposed"
      subtitle="Synthetic baseline (zero shares) vs the note's proposal — mirrors the existing BasketCompare primitive"
      endpoint="GET /api/research/notes/[id]/ic-summary"
      db="institutional"
      dataSource="supabase"
    >
      <BasketCompare
        current={{
          holdings: current,
          totals: totalsFor(current),
          sectors: [],
        }}
        proposed={{
          holdings: proposed,
          totals: totalsFor(proposed),
          sectors: [],
        }}
        currentTable={
          <HoldingsTable rows={current} constituentTotal={0} cash={0} cashPct={0} basketMin={0} />
        }
        proposedTable={
          <RemovableHoldingsTable
            rows={proposed}
            constituentTotal={proposed.reduce((s, r) => s + r.shares, 0)}
            cash={0}
            cashPct={0}
            basketMin={0}
            researchedTickers={new Set()}
            ratingFor={() => null}
            onOpenResearch={() => undefined}
            onRemoveOne={() => undefined}
            onSetShares={() => undefined}
            cashLabel="Cash reserve"
          />
        }
      />
    </GlassSection>
  );
}
