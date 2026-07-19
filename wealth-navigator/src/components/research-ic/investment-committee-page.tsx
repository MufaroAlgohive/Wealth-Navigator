"use client";

/**
 * Investment Committee — the IC gate. Agenda pulls live from the pipeline:
 * rebalance proposals awaiting approval (rebalance_request_c status=pending) and
 * research notes submitted for a decision (research_note_c status=ic_pending).
 * Votes are cast on research notes (research_vote_c); the IC decision then
 * transitions the note (approved/rejected) and promotes rebalance proposals to
 * ic_approved, after which they can be released to the order book.
 *
 * Committee members, charter/quorum and the session-prep checklist are the
 * desk's standing config (static), matching the OEMS design.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, MinusCircle, Rocket, ThumbsDown, ThumbsUp, X } from "lucide-react";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import type { ProposedHolding, RebalanceRequest, ResearchNote, ResearchPerms } from "./types";
import { ActionBadge, RatingBadge, moneyR, rebalanceCodeMap, signedPct, useQuotes, weightPct } from "./ui";

const MEMBERS: Array<{
  initials: string;
  name: string;
  title: string;
  role: string;
  /** The "You" slot — always the signed-in viewer, matched by their session email. */
  self: boolean;
  /** Standing member's email for exact vote attribution (null placeholder never matches). */
  email: string | null;
}> = [
  { initials: "YO", name: "You", title: "Fund Manager / CIO", role: "CHAIR", self: true, email: null },
  { initials: "TM", name: "T. Molefe", title: "Chief Operating Officer", role: "VOTING", self: false, email: null },
  { initials: "LN", name: "L. Ndlovu", title: "Junior Analyst", role: "OBSERVER", self: false, email: null },
];
const CHARTER = [
  ["Quorum", "2 of 3 members. Chair has casting vote on tie."],
  ["Pre-read", "analyst circulates research note ≥ 24h before session."],
  ["Rebalance gate", "IC approval required before any change flows to the Rebalance Engine."],
  ["Cadence", "Tue & Thu 14:00 SAST · 60 min · minutes filed in Committee log."],
];
const CHECKLIST = [
  "All pending research notes uploaded",
  "Proposals within mandate & tracking-error budget",
  "Pre-trade compliance flags reviewed",
  "Cash & liquidity impact modelled",
  "Investor-communication draft prepared (if material)",
];

export function InvestmentCommitteePage({
  perms,
  viewerEmail,
  viewerName,
}: {
  perms: ResearchPerms;
  viewerEmail: string | null;
  viewerName: string | null;
}) {
  void viewerName;
  const qc = useQueryClient();

  const notesQ = useQuery<{ notes: ResearchNote[] }>({
    queryKey: ["ric-notes-all"],
    refetchInterval: 30_000,
    queryFn: async () =>
      (await (
        await fetch("/api/research/notes", { cache: "no-store" })
      )
        .json()
        .catch(() => ({ notes: [] }))) as { notes: ResearchNote[] },
  });
  const reqQ = useQuery<{ requests: RebalanceRequest[] }>({
    queryKey: ["ric-rebalance-requests"],
    refetchInterval: 30_000,
    queryFn: async () =>
      (await (
        await fetch("/api/rebalance/requests", { cache: "no-store" })
      )
        .json()
        .catch(() => ({ requests: [] }))) as { requests: RebalanceRequest[] },
  });

  const notes = notesQ.data?.notes ?? [];
  const requests = reqQ.data?.requests ?? [];
  const agendaNotes = notes.filter((n) => n.status === "ic_pending");
  const pendingReqs = requests.filter((r) => r.status === "pending");
  const approvedReqs = requests.filter((r) => r.status === "ic_approved");
  const recent = [
    ...notes
      .filter((n) => n.status === "approved" || n.status === "rejected")
      .map((n) => ({
        id: n.id,
        when: n.approved_at ?? n.updated_at,
        label: `${n.symbol} research note`,
        status: n.status,
      })),
    ...requests
      .filter((r) => r.status === "executed")
      .map((r) => ({
        id: r.id,
        when: r.executed_at ?? r.updated_at,
        label: `${r.strategy_id} rebalance`,
        status: "executed",
      })),
  ]
    .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
    .slice(0, 6);

  const agendaCount = agendaNotes.length + pendingReqs.length;
  const rebCodes = rebalanceCodeMap(requests);
  const [checks, setChecks] = React.useState<boolean[]>(CHECKLIST.map((_, i) => i < 3));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ric-notes-all"] });
    qc.invalidateQueries({ queryKey: ["ric-rebalance-requests"] });
  };

  return (
    <ResearchLabCanvas>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Investment Committee</h1>
          <p className="text-caption">Tuesdays &amp; Thursdays · 14:00 SAST · chaired by Fund Manager.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" /> Next session · Tuesday, 14 Jul
        </span>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <GlassSection title={`Agenda · ${agendaCount} item${agendaCount === 1 ? "" : "s"}`} dataSource="supabase" db="institutional">
            {agendaCount === 0 ? (
              <p className="text-caption">
                Nothing on the agenda. Submitted proposals and notes appear here.
              </p>
            ) : (
              <div className="space-y-4">
                {pendingReqs.map((r) => (
                  <RebalanceAgendaItem
                    key={r.id}
                    req={r}
                    code={rebCodes.get(r.id) ?? "REB"}
                    canApprove={perms.approveRebalance}
                    canVote={perms.approveRebalance}
                    viewerEmail={viewerEmail}
                    onChanged={refresh}
                  />
                ))}
                {agendaNotes.map((n) => (
                  <ResearchAgendaItem
                    key={n.id}
                    note={n}
                    perms={perms}
                    viewerEmail={viewerEmail}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </GlassSection>

          <GlassSection title={`Approved — ready for order book · ${approvedReqs.length}`} dataSource="supabase" db="institutional">
            {approvedReqs.length === 0 ? (
              <p className="text-caption">No approved proposals waiting.</p>
            ) : (
              <div className="space-y-4">
                {approvedReqs.map((r) => (
                  <ApprovedItem
                    key={r.id}
                    req={r}
                    code={rebCodes.get(r.id) ?? "REB"}
                    canPush={perms.pushRebalance}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </GlassSection>

          <GlassSection title="Recent decisions" dataSource="supabase" db="institutional">
            {recent.length === 0 ? (
              <p className="text-caption">No decisions logged yet.</p>
            ) : (
              <ul className="space-y-2">
                {recent.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-foreground/85">{d.label}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase",
                        d.status === "rejected"
                          ? "border-[hsl(var(--down)/0.35)] text-down"
                          : "border-[hsl(var(--up)/0.35)] text-up",
                      )}
                    >
                      {d.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </GlassSection>
        </div>

        {/* right rail — standing config */}
        <div className="space-y-5">
          <GlassSection title="Committee members" dataSource="seed">
            <div className="space-y-3">
              {MEMBERS.map((m) => (
                <div key={m.initials} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.06)] text-[10px] font-semibold text-muted-foreground">
                      {m.initials}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{m.name}</p>
                      <p className="truncate text-caption">{m.title}</p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-[hsl(var(--glass-border))] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {m.role}
                  </span>
                </div>
              ))}
            </div>
          </GlassSection>

          <GlassSection title="Charter · quorum & voting">
            <dl className="space-y-2.5">
              {CHARTER.map(([term, desc]) => (
                <div key={term}>
                  <dt className="text-[11px] font-semibold text-foreground">{term}</dt>
                  <dd className="text-caption">{desc}</dd>
                </div>
              ))}
            </dl>
          </GlassSection>

          <GlassSection title="Session prep checklist">
            <ul className="space-y-2">
              {CHECKLIST.map((item, i) => (
                <li key={item}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checks[i] ?? false}
                      onChange={(e) =>
                        setChecks((prev) => prev.map((c, idx) => (idx === i ? e.target.checked : c)))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-[hsl(var(--glass-border))]"
                    />
                    <span
                      className={cn(checks[i] ? "text-foreground/70 line-through" : "text-foreground/85")}
                    >
                      {item}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </GlassSection>
        </div>
      </div>
    </ResearchLabCanvas>
  );
}

// ── action table shared by rebalance agenda + approved items ────────────────
function CompositionTable({ rows }: { rows: ProposedHolding[] }) {
  const changed = rows.filter((r) => r.action && r.action !== "hold");
  const show = changed.length ? changed : rows;
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--glass-border))]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Ticker</th>
            <th className="px-3 py-2 text-right font-medium">Weight</th>
            <th className="px-3 py-2 font-medium">Research</th>
            <th className="px-3 py-2 font-medium">Rationale</th>
          </tr>
        </thead>
        <tbody>
          {show.map((h, i) => (
            <tr key={`${h.ticker}-${i}`} className="border-b border-[hsl(var(--glass-border))] last:border-0">
              <td className="px-3 py-2">
                <ActionBadge action={h.action} />
              </td>
              <td className="px-3 py-2">
                <span className="font-semibold text-primary">{h.ticker}</span>{" "}
                <span className="text-muted-foreground">{h.name}</span>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {h.fromWeight != null && h.toWeight != null
                  ? `${weightPct(h.fromWeight)} → ${weightPct(h.toWeight)}`
                  : h.weight != null
                    ? weightPct(h.weight)
                    : "—"}
              </td>
              <td className="px-3 py-2">
                {h.researchRef ? (
                  <span className="font-mono text-[11px] text-primary">{h.researchRef}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {h.rating ? (
                  <span className="ml-1">
                    <RatingBadge rating={h.rating} />
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-caption">{h.rationale ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useTransition(kind: "note" | "rebalance") {
  const [busy, setBusy] = React.useState<string | null>(null);
  const go = async (id: string, to_status: string, onChanged: () => void, reason?: string) => {
    setBusy(to_status);
    try {
      const url =
        kind === "note" ? `/api/research/notes/${id}/transition` : `/api/rebalance/requests/${id}/transition`;
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to_status, reason }),
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  return { busy, go };
}

/** Cast / revise an IC vote on a rebalance proposal. */
function useVote() {
  const [busy, setBusy] = React.useState<string | null>(null);
  const cast = async (id: string, vote: "yes" | "no" | "abstain", onChanged: () => void) => {
    setBusy(vote);
    try {
      await fetch(`/api/rebalance/requests/${id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vote }),
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  return { busy, cast };
}

function RebalanceAgendaItem({
  req,
  code,
  canApprove,
  canVote,
  viewerEmail,
  onChanged,
}: {
  req: RebalanceRequest;
  code: string;
  canApprove: boolean;
  canVote: boolean;
  viewerEmail: string | null;
  onChanged: () => void;
}) {
  const { busy, go } = useTransition("rebalance");
  const vote = useVote();
  const [open, setOpen] = React.useState(false);
  const rows = Array.isArray(req.proposed_composition) ? req.proposed_composition : [];
  const changes = rows.filter((r) => r.action && r.action !== "hold").length;

  const votes = req.votes ?? [];
  const tally =
    req.tally ?? { yes: 0, no: 0, abstain: 0, quorum: 3, threshold: 0.6, requiredYes: 2, ratio: 0, passed: false };
  const myVote = viewerEmail
    ? votes.find((v) => v.voter_email.toLowerCase() === viewerEmail.toLowerCase())?.vote ?? null
    : null;
  const busyAny = busy != null || vote.busy != null;

  // Per-member vote state for the committee-member pills (matches the Lovable
  // spec's "YO TM LN" row under the Vote: heading). The viewer's own pill is
  // clickable to cast a vote; the rest are read-only indicators.
  function pillFor(member: (typeof MEMBERS)[number]) {
    // Identity is a full, case-insensitive email comparison — never a substring
    // or initials. The "You" slot resolves to the signed-in viewer's session
    // email; every other pill matches its own standing-member email (a null
    // placeholder simply never matches a real vote).
    const memberEmail = member.self ? viewerEmail : member.email;
    const isMe = member.self && viewerEmail != null;
    const v = memberEmail
      ? votes.find((vt) => vt.voter_email.toLowerCase() === memberEmail.toLowerCase())
      : undefined;
    let tone = "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.04)] text-muted-foreground";
    let label = member.initials;
    if (v?.vote === "yes") {
      tone = "border-[hsl(var(--up)/0.45)] bg-[hsl(var(--up)/0.18)] text-up";
      label = `${member.initials} ✓`;
    } else if (v?.vote === "no") {
      tone = "border-[hsl(var(--down)/0.45)] bg-[hsl(var(--down)/0.18)] text-down";
      label = `${member.initials} ✗`;
    } else if (v?.vote === "abstain") {
      tone = "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.1)] text-muted-foreground";
      label = `${member.initials} —`;
    }
    const baseCls = cn(
      "inline-flex h-7 w-9 items-center justify-center rounded-full border text-[10px] font-semibold",
      tone,
      isMe && canVote && "cursor-pointer hover:ring-1 hover:ring-primary/40",
    );
    if (!isMe || !canVote) return <span className={baseCls}>{label}</span>;
    const next = myVote === "yes" ? "no" : myVote === "no" ? "abstain" : "yes";
    return (
      <button
        type="button"
        disabled={busyAny}
        onClick={() => vote.cast(req.id, next, onChanged)}
        className={cn(baseCls, "disabled:opacity-50")}
        title={`Click to vote ${next}`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-primary/35 bg-primary/12 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
            Rebalance
          </span>
          <span className="font-mono text-xs text-muted-foreground">{code}</span>
          <span className="text-sm font-medium">{req.strategy_id}</span>
          <span className="rounded border border-[hsl(var(--glass-border))] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {changes} chg
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            {open ? "Hide" : "Open"} ▾
          </button>
          <button
            type="button"
            disabled={!canApprove || busyAny}
            onClick={() => go(req.id, "rejected", onChanged)}
            title="Chair override — reject this proposal"
            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--glass-border))] px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)] disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Reject
          </button>
        </div>
      </div>

      {/* Vote: row with member pills (Lovable spec). */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Vote:
        </span>
        {MEMBERS.map((m) => (
          <div key={m.initials} className="flex items-center gap-1.5">
            {pillFor(m)}
          </div>
        ))}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(tally.ratio * 100)}% for ·{" "}
          {tally.passed ? (
            <span className="text-up">passed</span>
          ) : (
            <span>needs {Math.round(tally.threshold * 100)}% ({tally.requiredYes} of {tally.quorum})</span>
          )}
        </span>
      </div>

      {/* 60% vote gate — a proposal is promoted to the order-book lane once YES
          votes reach requiredYes. */}
      <div className="mb-3 rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            IC vote · <span className="text-[hsl(var(--up))]">{tally.yes} yes</span> ·{" "}
            <span className="text-[hsl(var(--down))]">{tally.no} no</span>
            {tally.abstain > 0 ? ` · ${tally.abstain} abstain` : ""}
          </span>
          <span>
            {tally.passed ? (
              <span className="font-medium text-[hsl(var(--up))]">
                passed · {Math.round(tally.threshold * 100)}% reached
              </span>
            ) : (
              <>
                needs {tally.requiredYes} yes ({Math.round(tally.threshold * 100)}% of {tally.quorum})
              </>
            )}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--foreground)/0.08)]">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              tally.passed ? "bg-[hsl(var(--up))]" : "bg-primary",
            )}
            style={{ width: `${Math.min(100, (tally.yes / Math.max(1, tally.requiredYes)) * 100)}%` }}
          />
        </div>
      </div>

      {open && (
        <div className="space-y-3 rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Composition drill-down
          </p>
          <CompositionTable rows={rows} />
          {changes > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Each change references an approved research note via the Research column above. Open
              the note from the Research Library to view the thesis, valuation & triggers.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovedItem({
  req,
  code,
  canPush,
  onChanged,
}: { req: RebalanceRequest; code: string; canPush: boolean; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const rows = Array.isArray(req.proposed_composition) ? req.proposed_composition : [];
  async function release() {
    setBusy(true);
    try {
      await fetch(`/api/rebalance/requests/${req.id}/push`, { method: "POST" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-[hsl(var(--up)/0.25)] bg-[hsl(var(--up)/0.04)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.12)] px-2 py-0.5 text-[10px] font-semibold uppercase text-up">
            Approved
          </span>
          <span className="font-mono text-xs text-muted-foreground">{code}</span>
          <span className="text-sm font-medium">{req.strategy_id}</span>
        </div>
        <button
          type="button"
          disabled={!canPush || busy}
          onClick={release}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Rocket className="h-3.5 w-3.5" /> {busy ? "Releasing…" : "Release to Order Book"}
        </button>
      </div>
      <CompositionTable rows={rows} />
    </div>
  );
}

function ResearchAgendaItem({
  note,
  perms,
  viewerEmail,
  onChanged,
}: {
  note: ResearchNote;
  perms: ResearchPerms;
  viewerEmail: string | null;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { busy, go } = useTransition("note");
  const [voting, setVoting] = React.useState<string | null>(null);
  const th = note.thesis ?? {};
  const quotes = useQuotes([note.symbol]);
  const current = quotes.data?.[note.symbol.toUpperCase()]?.last ?? null;
  const target = th.targetPrice ?? null;
  const upside =
    current != null && target != null && current > 0 ? ((target - current) / current) * 100 : null;

  const sumQ = useQuery<{ tally: { yes: number; no: number; abstain: number; total: number } }>({
    queryKey: ["ric-ic-summary", note.id],
    refetchInterval: 20_000,
    queryFn: async () =>
      (await (
        await fetch(`/api/research/notes/${note.id}/ic-summary`, { cache: "no-store" })
      )
        .json()
        .catch(() => ({ tally: { yes: 0, no: 0, abstain: 0, total: 0 } }))) as {
        tally: { yes: number; no: number; abstain: number; total: number };
      },
  });
  const tally = sumQ.data?.tally ?? { yes: 0, no: 0, abstain: 0, total: 0 };
  const QUORUM = 2;

  async function vote(v: "yes" | "no" | "abstain") {
    setVoting(v);
    try {
      await fetch(`/api/research/notes/${note.id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vote: v }),
      });
      await qc.invalidateQueries({ queryKey: ["ric-ic-summary", note.id] });
    } finally {
      setVoting(null);
    }
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--glass-border))] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-amber-400/40 bg-amber-400/12 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-500">
            Research init
          </span>
          <span className="text-sm font-semibold">{note.symbol}</span>
          <RatingBadge rating={th.rating} />
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {target != null && <span>TP {moneyR(target, 0)}</span>}
          {upside != null && (
            <span className={upside >= 0 ? "text-up" : "text-down"}>Upside {signedPct(upside)}</span>
          )}
          {th.analystName && <span>Analyst {th.analystName}</span>}
          {th.horizon && <span>Horizon {th.horizon}</span>}
        </div>
      </div>
      {th.bull && <p className="mt-2 text-xs leading-relaxed text-foreground/80">{th.bull}</p>}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--glass-border))] pt-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Vote:</span>
          <button
            type="button"
            disabled={!perms.castVote || voting != null}
            onClick={() => vote("yes")}
            className="rounded-md border border-[hsl(var(--glass-border))] p-1.5 text-muted-foreground hover:text-up disabled:opacity-50"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!perms.castVote || voting != null}
            onClick={() => vote("abstain")}
            className="rounded-md border border-[hsl(var(--glass-border))] p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <MinusCircle className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!perms.castVote || voting != null}
            onClick={() => vote("no")}
            className="rounded-md border border-[hsl(var(--glass-border))] p-1.5 text-muted-foreground hover:text-down disabled:opacity-50"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
          <span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {tally.yes} for / {tally.no} against · quorum {QUORUM}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!perms.approveNote || busy != null}
            onClick={() => go(note.id, "rejected", onChanged, "IC rejected")}
            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--foreground)/0.05)] disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Reject
          </button>
          <button
            type="button"
            disabled={!perms.approveNote || busy != null}
            onClick={() => go(note.id, "approved", onChanged, "IC approved")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Approve to Rebalance
          </button>
        </div>
      </div>
    </div>
  );
}
