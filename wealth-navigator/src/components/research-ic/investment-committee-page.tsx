"use client";

/**
 * Investment Committee — the IC gate. Agenda pulls live from the pipeline:
 * rebalance proposals awaiting approval (rebalance_request_c status=pending) and
 * research notes submitted for a decision (research_note_c status=ic_pending).
 * Votes are cast on research notes (research_vote_c); the IC decision then
 * transitions the note (approved/rejected) and promotes rebalance proposals to
 * ic_approved, after which they can be released to the order book.
 *
 * Committee members are sourced from `lib/research-ic/committee.ts` (the 3
 * standing voters — Lonwabo, Juan, Lethabo). The chair has a casting vote on
 * a 1-1 tie; the gate is strict majority (≥ 2 of 3).
 *
 * UX:
 *   - Compact tabs for actionable queues. Standing committee context remains
 *     alongside the agenda instead of being hidden in separate tabs.
 *   - Each major section is collapsible (header click toggles). Sections
 *     default to expanded when they contain items, collapsed when empty.
 *   - "Back to top" floating button appears once the user scrolls past the
 *     first section.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  MinusCircle,
  Rocket,
  ScrollText,
  ThumbsDown,
  ThumbsUp,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import {
  type CommitteeMember,
  IC_COMMITTEE_SIZE,
  IC_MAJORITY_REQUIRED_YES,
} from "@/lib/research-ic/committee";
import { CommitteeGovernance } from "./committee-governance";
import { CommitteeRightRail } from "./committee-right-rail";
import {
  agendaKindForNote,
  agendaKindForRebalance,
  icRebalanceActionLabel,
  icResearchApproveLabel,
  linkedNoteForRebalance,
  linkedRebalanceForNote,
} from "./ic-agenda";
import type { ProposedHolding, RebalanceRequest, ResearchNote, ResearchPerms } from "./types";
import {
  ActionBadge,
  RatingBadge,
  moneyR,
  rebalanceCodeMap,
  rebalanceDisplayLabel,
  signedPct,
  useQuotes,
  weightPct,
} from "./ui";

const CHARTER = [
  [
    "Quorum",
    `${IC_COMMITTEE_SIZE} voting members. Strict majority (≥ ${IC_MAJORITY_REQUIRED_YES} of ${IC_COMMITTEE_SIZE}) carries a decision; abstentions do not lower the bar.`,
  ],
  [
    "Chair tie-break",
    "If a vote ends 1-1, the chair's ballot (cast on or before the deadline) counts as the deciding vote. A 0-0-3 does not pass.",
  ],
  ["Pre-read", "Analyst circulates research note ≥ 24h before session."],
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

/** Pill shape used by the per-member vote indicator row. */
interface MemberPill {
  initials: string;
  displayName: string;
  role: "chair" | "voting" | "observer";
  email: string;
  /** True when this slot is the signed-in viewer (always clickable). */
  isViewer: boolean;
}

const TITLES_BY_ROLE: Record<MemberPill["role"], string> = {
  chair: "Chair · CIO",
  voting: "Investment Committee",
  observer: "Observer",
};

/** Build the committee pill list, marking the viewer's own slot. */
function buildCommitteePills(members: CommitteeMember[], viewerEmail: string | null): MemberPill[] {
  const v = viewerEmail?.toLowerCase() ?? null;
  return members.map((m) => ({
    initials: m.initials,
    displayName: m.displayName,
    role: m.role,
    email: m.email,
    isViewer: v != null && m.email !== "" && m.email === v,
  }));
}

export function InvestmentCommitteePage({
  perms,
  viewerEmail,
  viewerName,
  canSeeUat,
}: {
  perms: ResearchPerms;
  viewerEmail: string | null;
  viewerName: string | null;
  canSeeUat: boolean;
}) {
  void viewerName;
  const qc = useQueryClient();

  // Pull committee roster (emails resolved at runtime from admin_team when
  // possible). The fallback inside the helper still gives us the 3 names so
  // the UI never goes blank — only voting is disabled until emails resolve.
  const [committee, setCommittee] = React.useState<CommitteeMember[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/research/committee", { cache: "no-store" });
        const j = (await r.json().catch(() => null)) as { members?: CommitteeMember[] } | null;
        if (!cancelled && j?.members) setCommittee(j.members);
      } catch {
        // Soft fail — leave committee empty; UI shows the static fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const pills = React.useMemo(() => buildCommitteePills(committee, viewerEmail), [committee, viewerEmail]);

  type SectionId = "agenda" | "approved" | "recent" | "uat" | "governance";
  const [active, setActive] = React.useState<SectionId>("agenda");
  const activeScope = active === "uat" ? "uat" : "live";
  const notesQ = useQuery<{ notes: ResearchNote[] }>({
    queryKey: ["ric-notes-all", activeScope],
    refetchInterval: 30_000,
    queryFn: async () =>
      (await (
        await fetch(`/api/research/notes?scope=${activeScope}`, { cache: "no-store" })
      )
        .json()
        .catch(() => ({ notes: [] }))) as { notes: ResearchNote[] },
  });
  const reqQ = useQuery<{ requests: RebalanceRequest[] }>({
    queryKey: ["ric-rebalance-requests", activeScope],
    refetchInterval: 30_000,
    queryFn: async () =>
      (await (
        await fetch(`/api/rebalance/requests?scope=${activeScope}`, { cache: "no-store" })
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
        label: `${rebalanceDisplayLabel(r)} rebalance`,
        status: "executed",
      })),
  ]
    .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
    .slice(0, 6);

  const agendaCount = agendaNotes.length + pendingReqs.length;
  const [agendaFilter, setAgendaFilter] = React.useState<"all" | "research" | "rebalance">("all");
  const visibleReqs = agendaFilter === "research" ? [] : pendingReqs;
  const visibleNotes = agendaFilter === "rebalance" ? [] : agendaNotes;
  const rebCodes = rebalanceCodeMap(requests);
  const [checks, setChecks] = React.useState<boolean[]>(CHECKLIST.map((_, i) => i < 3));

  // ── Section collapse state (default: expanded when non-empty) ───────────
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>(() => ({
    agenda: true,
    approved: true,
    recent: true,
    governance: true,
  }));
  const toggleSection = (k: string) => setOpenSections((prev) => ({ ...prev, [k]: !prev[k] }));

  // ── Sticky tab bar + scroll-spy ──────────────────────────────────────────
  const sections: Array<{
    id: SectionId;
    label: string;
    count?: number;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: "agenda", label: "Agenda", count: agendaCount, icon: ScrollText },
    { id: "approved", label: "Approved", count: approvedReqs.length, icon: Rocket },
    { id: "recent", label: "Recent", count: recent.length, icon: Calendar },
    ...(canSeeUat ? [{ id: "uat" as const, label: "UAT", count: 0, icon: Rocket }] : []),
    { id: "governance", label: "Settings", icon: Users },
  ];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ric-notes-all"] });
    qc.invalidateQueries({ queryKey: ["ric-rebalance-requests"] });
  };

  return (
    <ResearchLabCanvas>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Investment Committee</h1>
          <p className="text-caption">
            Tuesdays &amp; Thursdays · 14:00 SAST · majority vote ({IC_MAJORITY_REQUIRED_YES} of{" "}
            {IC_COMMITTEE_SIZE}).
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" /> Next session · Tuesday, 14 Jul
        </span>
      </header>

      {/* ── Sticky in-page navigator ─────────────────────────────────────── */}
      <nav
        aria-label="Investment Committee sections"
        className="sticky top-0 z-30 -mx-1 mt-3 flex items-center gap-1 overflow-x-auto rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--background)/0.85)] px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.7)]"
      >
        {sections.map((s) => {
          const isActive = active === s.id;
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)] hover:text-foreground",
              )}
              aria-current={isActive ? "true" : undefined}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{s.label}</span>
              {typeof s.count === "number" && s.count > 0 ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums",
                    isActive
                      ? "bg-primary/25 text-primary"
                      : "bg-[hsl(var(--foreground)/0.08)] text-muted-foreground",
                  )}
                >
                  {s.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-5">
          {/* ── Agenda ──────────────────────────────────────────────────── */}
          {active === "agenda" && (
            <section>
              <CollapsibleCard
                title={`Agenda · ${agendaCount} item${agendaCount === 1 ? "" : "s"}`}
                dataSource="supabase"
                db="institutional"
                open={!!openSections.agenda}
                onToggle={() => toggleSection("agenda")}
                badge={
                  agendaCount > 0
                    ? {
                        tone: "warn",
                        label: `${pendingReqs.length} rebalance · ${agendaNotes.length} research`,
                      }
                    : null
                }
              >
                {agendaCount > 0 ? (
                  <div className="mb-3 inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--background)/0.6)] p-1">
                    {(
                      [
                        { id: "all", label: "All", count: agendaCount },
                        { id: "research", label: "Research", count: agendaNotes.length },
                        { id: "rebalance", label: "Rebalance", count: pendingReqs.length },
                      ] as const
                    ).map((f) => {
                      const isActive = agendaFilter === f.id;
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setAgendaFilter(f.id)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                            isActive
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)] hover:text-foreground",
                          )}
                          aria-pressed={isActive}
                        >
                          {f.label}
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums",
                              isActive
                                ? "bg-primary/25 text-primary"
                                : "bg-[hsl(var(--foreground)/0.08)] text-muted-foreground",
                            )}
                          >
                            {f.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {agendaCount === 0 ? (
                  <p className="text-caption">
                    Nothing on the agenda. Submitted proposals and notes appear here.
                  </p>
                ) : visibleReqs.length === 0 && visibleNotes.length === 0 ? (
                  <p className="text-caption">Nothing matches this filter.</p>
                ) : (
                  <div className="space-y-4">
                    {visibleReqs.map((r) => (
                      <RebalanceAgendaItem
                        key={r.id}
                        req={r}
                        code={rebCodes.get(r.id) ?? "REB"}
                        linkedNote={linkedNoteForRebalance(r, agendaNotes)}
                        canApprove={perms.approveRebalance}
                        canApproveNote={perms.approveNote}
                        canVote={perms.approveRebalance}
                        viewerEmail={viewerEmail}
                        pills={pills}
                        onChanged={refresh}
                      />
                    ))}
                    {visibleNotes.map((n) => (
                      <ResearchAgendaItem
                        key={n.id}
                        note={n}
                        linkedRebalance={linkedRebalanceForNote(n, pendingReqs)}
                        perms={perms}
                        viewerEmail={viewerEmail}
                        pills={pills}
                        onChanged={refresh}
                      />
                    ))}
                  </div>
                )}
              </CollapsibleCard>
            </section>
          )}

          {active === "governance" && (
            <section>
              <CollapsibleCard
                title="IC voting settings"
                dataSource="supabase"
                db="institutional"
                open={!!openSections.governance}
                onToggle={() => toggleSection("governance")}
              >
                <CommitteeGovernance />
              </CollapsibleCard>
            </section>
          )}

          {/* ── Approved ─────────────────────────────────────────────────── */}
          {active === "approved" && (
            <section>
              <CollapsibleCard
                title={`Approved — ready for Rebalance tab · ${approvedReqs.length}`}
                dataSource="supabase"
                db="institutional"
                open={!!openSections.approved}
                onToggle={() => toggleSection("approved")}
              >
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
              </CollapsibleCard>
            </section>
          )}

          {/* ── Recent decisions ─────────────────────────────────────────── */}
          {active === "recent" && (
            <section>
              <CollapsibleCard
                title="Recent decisions"
                dataSource="supabase"
                db="institutional"
                open={!!openSections.recent}
                onToggle={() => toggleSection("recent")}
              >
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
              </CollapsibleCard>
            </section>
          )}

          {active === "uat" && canSeeUat && (
            <section>
              <CollapsibleCard title={`UAT strategy work · ${agendaCount} pending`} dataSource="supabase" db="institutional" open onToggle={() => undefined}>
                <p className="mb-3 text-caption">UAT research, votes and rebalance proposals are isolated from LIVE.</p>
                {agendaCount === 0 && approvedReqs.length === 0 && recent.length === 0 ? <p className="text-caption">No UAT research or strategy proposals yet.</p> : <div className="space-y-4">{visibleReqs.map((r) => <RebalanceAgendaItem key={r.id} req={r} code={rebCodes.get(r.id) ?? "REB"} linkedNote={linkedNoteForRebalance(r, agendaNotes)} canApprove={perms.approveRebalance} canApproveNote={perms.approveNote} canVote={perms.approveRebalance} viewerEmail={viewerEmail} pills={pills} onChanged={refresh} />)}{visibleNotes.map((n) => <ResearchAgendaItem key={n.id} note={n} linkedRebalance={linkedRebalanceForNote(n, pendingReqs)} perms={perms} viewerEmail={viewerEmail} pills={pills} onChanged={refresh} />)}</div>}
              </CollapsibleCard>
            </section>
          )}

          {/* ── Members (also surfaced in right rail) ─────────────────────── */}
          {false && (
            <section>
              <CollapsibleCard
                title="Committee members"
                dataSource="supabase"
                db="institutional"
                open={!!openSections.members}
                onToggle={() => toggleSection("members")}
              >
                <MembersList pills={pills} viewerEmail={viewerEmail} />
              </CollapsibleCard>
            </section>
          )}

          {/* ── Charter (also surfaced in right rail) ─────────────────────── */}
          {false && (
            <section>
              <CollapsibleCard
                title="Charter · quorum & voting"
                dataSource="seed"
                open={!!openSections.charter}
                onToggle={() => toggleSection("charter")}
              >
                <CharterList />
              </CollapsibleCard>
            </section>
          )}

          {/* ── Prep checklist (also surfaced in right rail) ──────────────── */}
          {false && (
            <section>
              <CollapsibleCard
                title="Session prep checklist"
                dataSource="seed"
                open={!!openSections.checklist}
                onToggle={() => toggleSection("checklist")}
              >
                <ChecklistList
                  checks={checks}
                  onChange={(i, v) => setChecks((prev) => prev.map((c, idx) => (idx === i ? v : c)))}
                />
              </CollapsibleCard>
            </section>
          )}
        </div>

        {/* right rail — standing config (desktop) */}
        {(active === "agenda" || active === "approved" || (active === "uat" && canSeeUat)) && <div className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <CommitteeRightRail scope={active === "uat" ? "uat" : "live"} canSeeUat={canSeeUat} compact />
          {active !== "uat" && <>
          <GlassSection title="Committee members" dataSource="supabase" db="institutional">
            <MembersList pills={pills} viewerEmail={viewerEmail} />
          </GlassSection>

          <GlassSection title="Charter · quorum & voting">
            <CharterList />
          </GlassSection>

          <GlassSection title="Session prep checklist">
            <ChecklistList
              checks={checks}
              onChange={(i, v) => setChecks((prev) => prev.map((c, idx) => (idx === i ? v : c)))}
            />
          </GlassSection>
          </>}
        </div>}
      </div>

      {/* ── Floating back-to-top button (only after first section) ─────── */}
    </ResearchLabCanvas>
  );
}

// ── right-rail components ───────────────────────────────────────────────────
function CommitteeContextPanel({
  pills,
  viewerEmail,
  checks,
  onCheckChange,
}: {
  pills: MemberPill[];
  viewerEmail: string | null;
  checks: boolean[];
  onCheckChange: (i: number, value: boolean) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <div className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] p-3.5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold">Committee members</h2>
          <span className="rounded-md border border-[hsl(var(--glass-border))] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            IC
          </span>
        </div>
        <MembersList pills={pills} viewerEmail={viewerEmail} />
      </div>
      <div className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] p-3.5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold">Charter · quorum & voting</h2>
          <ScrollText className="h-3.5 w-3.5 text-primary" />
        </div>
        <CharterList />
      </div>
      <div className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] p-3.5 md:col-span-2 xl:col-span-1">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold">Session prep checklist</h2>
          <span className="font-mono text-[10px] text-muted-foreground">
            {checks.filter(Boolean).length}/{CHECKLIST.length}
          </span>
        </div>
        <ChecklistList checks={checks} onChange={onCheckChange} />
      </div>
    </div>
  );
}

function MembersList({ pills, viewerEmail }: { pills: MemberPill[]; viewerEmail: string | null }) {
  void viewerEmail;
  if (pills.length === 0) {
    return <p className="text-caption">Resolving committee roster…</p>;
  }
  return (
    <div className="space-y-3">
      {pills.map((m) => (
        <div key={m.initials + m.email} className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.06)] text-[10px] font-semibold text-muted-foreground">
              {m.initials}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {m.displayName}
                {m.isViewer ? <span className="ml-1 text-[10px] text-muted-foreground">(you)</span> : null}
              </p>
              <p className="truncate text-caption">{TITLES_BY_ROLE[m.role]}</p>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
              m.role === "chair"
                ? "border-primary/35 bg-primary/10 text-primary"
                : "border-[hsl(var(--glass-border))] text-muted-foreground",
            )}
          >
            {m.role}
          </span>
        </div>
      ))}
    </div>
  );
}

function CharterList() {
  return (
    <dl className="space-y-2.5">
      {CHARTER.map(([term, desc]) => (
        <div key={term}>
          <dt className="text-[11px] font-semibold text-foreground">{term}</dt>
          <dd className="text-caption">{desc}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChecklistList({
  checks,
  onChange,
}: {
  checks: boolean[];
  onChange: (i: number, v: boolean) => void;
}) {
  return (
    <ul className="space-y-2">
      {CHECKLIST.map((item, i) => (
        <li key={item}>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={checks[i] ?? false}
              onChange={(e) => onChange(i, e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[hsl(var(--glass-border))]"
            />
            <span className={cn(checks[i] ? "text-foreground/70 line-through" : "text-foreground/85")}>
              {item}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** GlassSection wrapper that adds a click-to-collapse header chrome. */
function CollapsibleCard({
  title,
  dataSource,
  db,
  open,
  onToggle,
  badge,
  children,
}: {
  title: string;
  dataSource: "supabase" | "seed" | "hybrid";
  db?: "retail" | "institutional";
  open: boolean;
  onToggle: () => void;
  badge?: { tone: "warn" | "ok"; label: string } | null;
  children: React.ReactNode;
}) {
  return (
    <GlassSection
      title={title}
      dataSource={dataSource}
      db={db}
      right={
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[hsl(var(--glass-border))] px-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)]"
        >
          {open ? "Collapse" : "Expand"}
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      }
    >
      {badge ? (
        <div className="mb-3">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              badge.tone === "warn"
                ? "border-amber-400/40 bg-amber-400/10 text-amber-500"
                : "border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.1)] text-up",
            )}
          >
            {badge.label}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          "transition-all duration-200",
          open ? "max-h-[8000px] opacity-100" : "max-h-0 -translate-y-1 overflow-hidden opacity-0",
        )}
        aria-hidden={!open}
      >
        {children}
      </div>
    </GlassSection>
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
                <span className="font-mono font-semibold text-foreground">{h.ticker}</span>{" "}
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
      const r = await fetch(`/api/rebalance/requests/${id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vote }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `vote failed (${r.status})`);
      }
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
  linkedNote,
  canApprove,
  canApproveNote,
  canVote,
  viewerEmail,
  pills,
  onChanged,
}: {
  req: RebalanceRequest;
  code: string;
  linkedNote?: ResearchNote;
  canApprove: boolean;
  canApproveNote: boolean;
  canVote: boolean;
  viewerEmail: string | null;
  pills: MemberPill[];
  onChanged: () => void;
}) {
  const { busy, go } = useTransition("rebalance");
  const noteTransition = useTransition("note");
  const vote = useVote();
  const [open, setOpen] = React.useState(false);
  const rows = Array.isArray(req.proposed_composition) ? req.proposed_composition : [];
  const changes = rows.filter((r) => r.action && r.action !== "hold").length;
  const kind = agendaKindForRebalance(req, linkedNote ? [linkedNote] : []);
  const actionLabel = icRebalanceActionLabel(kind);
  const canCombinedApprove = kind === "both" && canApprove && canApproveNote && linkedNote;

  const votes = req.votes ?? [];
  const tally = req.tally ?? {
    yes: 0,
    no: 0,
    abstain: 0,
    quorum: IC_COMMITTEE_SIZE,
    threshold: IC_MAJORITY_REQUIRED_YES / IC_COMMITTEE_SIZE,
    requiredYes: IC_MAJORITY_REQUIRED_YES,
    ratio: 0,
    passed: false,
  };
  const myVote = viewerEmail
    ? (votes.find((v) => v.voter_email.toLowerCase() === viewerEmail.toLowerCase())?.vote ?? null)
    : null;
  const busyAny = busy != null || vote.busy != null || noteTransition.busy != null;

  // Standalone rebalance approval (no linked research note — the "both" path
  // above has its own combined-approve gate). The committee majority is
  // required for every strategy, UAT included — a rebalance on a test
  // strategy is a real rehearsal of this gate, not a reason to skip it (the
  // server enforces the same rule now: transition/route.ts rejects
  // pending -> ic_approved without it, so this button matches what the API
  // will actually allow rather than offering a click that 403s).
  //
  // Gated on the real majority (tally.passed = yes >= requiredYes), not
  // merely "yes outnumbers no" — with only 1 of 3 votes in, yes=1/no=0
  // "leads" but is not yet a majority. Approve stays visible-but-disabled
  // while votes are pending (nothing to disagree with yet); it hides
  // entirely once no votes outnumber yes, since no further yes votes can
  // change the outcome and only Reject remains meaningful.
  const hasVotes = tally.yes > 0 || tally.no > 0;
  const noAhead = tally.no > tally.yes;
  const showStandaloneApprove = kind !== "both" && !noAhead;
  const standaloneApproveDisabled = !canApprove || busyAny || !tally.passed;
  const standaloneApproveTitle = !hasVotes
    ? "Awaiting votes — no votes cast yet"
    : !tally.passed
      ? `Awaiting votes — ${tally.yes} of ${tally.requiredYes} required yes votes`
      : "Approve — committee majority reached";

  async function approveBoth() {
    if (!linkedNote) return;
    await noteTransition.go(linkedNote.id, "approved", onChanged, "IC approved with rebalance");
    await go(req.id, "ic_approved", onChanged, "IC approved with research");
  }

  async function approveStandalone() {
    await go(req.id, "ic_approved", onChanged, "IC approved by majority vote");
  }

  // Per-member vote state for the committee-member pills. Only the viewer's
  // own pill is clickable (when they're a recognised committee member); the
  // rest are read-only indicators.
  function pillFor(member: MemberPill) {
    const memberEmail = member.email;
    const isMe = member.isViewer;
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
          <span className="text-sm font-medium">{rebalanceDisplayLabel(req)}</span>
          <span className="rounded border border-[hsl(var(--glass-border))] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {changes} chg
          </span>
        </div>
        <div className="flex items-center gap-3">
          {linkedNote ? (
            <Link
              href={`/oems/research?note=${encodeURIComponent(linkedNote.id)}`}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
            >
              View research <ExternalLink className="h-3 w-3" />
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            {open ? "Hide" : actionLabel} ▾
          </button>
          {kind === "both" ? (
            <button
              type="button"
              // canCombinedApprove only checked the two approve PERMISSIONS
              // (note + rebalance), never whether the committee had actually
              // voted — the rebalance side of this button called the same
              // transition endpoint as the standalone one, with no vote gate
              // at all. Same tally.passed rule as standalone now, since the
              // server enforces it identically either way.
              disabled={!canCombinedApprove || busyAny || !tally.passed}
              onClick={approveBoth}
              title={
                !tally.passed
                  ? `Awaiting votes — ${tally.yes} of ${tally.requiredYes} required yes votes`
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> {actionLabel}
            </button>
          ) : showStandaloneApprove ? (
            <button
              type="button"
              disabled={standaloneApproveDisabled}
              onClick={approveStandalone}
              title={standaloneApproveTitle}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> Approve
            </button>
          ) : null}
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
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Vote:</span>
        {pills.map((m) => (
          <div key={m.initials + m.email} className="flex items-center gap-1.5">
            {pillFor(m)}
          </div>
        ))}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(tally.ratio * 100)}% for ·{" "}
          {tally.passed ? (
            <span className="text-up">passed</span>
          ) : (
            <span>
              needs {tally.requiredYes} of {tally.quorum} ({Math.round(tally.threshold * 100)}%)
            </span>
          )}
        </span>
      </div>

      {/* Majority-vote gate — a proposal is promoted to the order-book lane once
          YES votes reach the strict-majority threshold (≥ 2 of 3 by default). */}
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
                passed · {tally.yes} ≥ {tally.requiredYes} (majority)
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
              Each change references an approved research note via the Research column above. Open the note
              from the Research Library to view the thesis, valuation & triggers.
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
      const res = await fetch(`/api/rebalance/requests/${req.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to_status: "executed" }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        window.alert(body.error ?? "Failed to release to the Rebalance tab.");
      }
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
          <span className="text-sm font-medium">{rebalanceDisplayLabel(req)}</span>
        </div>
        <button
          type="button"
          disabled={!canPush || busy}
          onClick={release}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Releasing…
            </>
          ) : (
            <>
              <Rocket className="h-3.5 w-3.5" /> Release to Rebalance Tab
            </>
          )}
        </button>
      </div>
      <CompositionTable rows={rows} />
    </div>
  );
}

function ResearchAgendaItem({
  note,
  linkedRebalance,
  perms,
  viewerEmail,
  pills,
  onChanged,
}: {
  note: ResearchNote;
  linkedRebalance?: RebalanceRequest;
  perms: ResearchPerms;
  viewerEmail: string | null;
  pills: MemberPill[];
  onChanged: () => void;
}) {
  void pills;
  const qc = useQueryClient();
  const { busy, go } = useTransition("note");
  const rebalanceTransition = useTransition("rebalance");
  const [voting, setVoting] = React.useState<string | null>(null);
  const [voteError, setVoteError] = React.useState<string | null>(null);
  const kind = agendaKindForNote(note, linkedRebalance ? [linkedRebalance] : []);
  const approveLabel = icResearchApproveLabel(kind);
  const canCombinedApprove =
    kind === "both" ? perms.approveNote && perms.approveRebalance : perms.approveNote;
  const busyAny = busy != null || rebalanceTransition.busy != null;
  const scope = note.environment_scope === "uat" ? "uat" : "live";
  const governanceQ = useQuery<{
    scopes?: Record<string, { members: Array<{ role: string; vote_scope: string[] }>; policy: { approval_mode: "count" | "percentage"; required_yes_count: number; required_yes_percent: number; auto_decide_research: boolean; manual_research_decision_enabled: boolean } }>;
  }>({
    queryKey: ["ric-governance", scope],
    queryFn: async () => (await fetch("/api/research/committee/governance", { cache: "no-store" })).json(),
    staleTime: 30_000,
  });

  async function handleApprove() {
    if (kind === "both" && linkedRebalance && perms.approveRebalance) {
      await go(note.id, "approved", onChanged, "IC approved with rebalance");
      await rebalanceTransition.go(linkedRebalance.id, "ic_approved", onChanged, "IC approved with research");
      return;
    }
    await go(note.id, "approved", onChanged, "IC approved");
  }

  const th = note.thesis ?? {};
  const quotes = useQuotes([note.symbol]);
  const current = quotes.data?.[note.symbol.toUpperCase()]?.last ?? null;
  const target = th.targetPrice ?? null;
  const upside =
    current != null && target != null && current > 0 ? ((target - current) / current) * 100 : null;

  const sumQ = useQuery<{
    tally: { yes: number; no: number; abstain: number; total: number };
    votes: Array<{ voter_email: string; vote: "yes" | "no" | "abstain" }>;
  }>({
    queryKey: ["ric-ic-summary", note.id],
    refetchInterval: 20_000,
    queryFn: async () =>
      (await (
        await fetch(`/api/research/notes/${note.id}/ic-summary`, { cache: "no-store" })
      )
        .json()
        .catch(() => ({ tally: { yes: 0, no: 0, abstain: 0, total: 0 }, votes: [] }))) as {
        tally: { yes: number; no: number; abstain: number; total: number };
        votes: Array<{ voter_email: string; vote: "yes" | "no" | "abstain" }>;
      },
  });
  const tally = sumQ.data?.tally ?? { yes: 0, no: 0, abstain: 0, total: 0 };
  const viewerVote = sumQ.data?.votes.find(
    (vote) => vote.voter_email.toLowerCase() === viewerEmail?.toLowerCase(),
  )?.vote;
  const policy = governanceQ.data?.scopes?.[scope]?.policy;
  const researchVoters = governanceQ.data?.scopes?.[scope]?.members.filter(
    (member) => member.role !== "observer" && member.vote_scope.includes("research"),
  ).length ?? 0;
  const voteThreshold = policy?.approval_mode === "percentage"
    ? Math.max(1, Math.ceil((Math.max(1, researchVoters) * policy.required_yes_percent) / 100))
    : Math.max(1, policy?.required_yes_count ?? IC_MAJORITY_REQUIRED_YES);
  const manualDecisionEnabled = policy?.manual_research_decision_enabled === true;
  const manualApproveReady = tally.yes >= voteThreshold;
  const manualRejectReady = tally.no >= voteThreshold;

  async function vote(v: "yes" | "no" | "abstain") {
    setVoting(v);
    setVoteError(null);
    try {
      const r = await fetch(`/api/research/notes/${note.id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vote: v }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setVoteError(body.error ?? `Vote was rejected (${r.status}).`);
        return;
      }
      await qc.invalidateQueries({ queryKey: ["ric-ic-summary", note.id] });
      await qc.invalidateQueries({ queryKey: ["ric-notes-all"] });
    } finally {
      setVoting(null);
    }
  }

  const majorityMet = tally.yes >= voteThreshold;

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
          <Link
            href={`/oems/research?note=${encodeURIComponent(note.id)}`}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            View research <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>
      {th.bull && <p className="mt-2 text-xs leading-relaxed text-foreground/80">{th.bull}</p>}

      <div className="mt-3 rounded-lg border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] p-2.5">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{scope.toUpperCase()} voting progress</span>
          <span>{tally.yes}/{voteThreshold} yes required</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-[hsl(var(--foreground)/0.08)]">
          {tally.yes > 0 && <span className="bg-up" style={{ width: `${(tally.yes / Math.max(1, researchVoters)) * 100}%` }} />}
          {tally.no > 0 && <span className="bg-down" style={{ width: `${(tally.no / Math.max(1, researchVoters)) * 100}%` }} />}
          {tally.abstain > 0 && <span className="bg-muted-foreground/60" style={{ width: `${(tally.abstain / Math.max(1, researchVoters)) * 100}%` }} />}
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">{tally.yes} yes · {tally.no} no · {tally.abstain} abstain · {Math.max(0, researchVoters - tally.total)} not yet voted</p>
      </div>
      {voteError && <p className="mt-2 text-xs text-down">{voteError}</p>}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--glass-border))] pt-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Vote:</span>
          <button
            type="button"
            disabled={!perms.castVote || voting != null}
            onClick={() => vote("yes")}
            className={cn("rounded-md border p-1.5 disabled:opacity-50", viewerVote === "yes" ? "border-up/60 bg-up/15 text-up" : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-up")}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!perms.castVote || voting != null}
            onClick={() => vote("abstain")}
            className={cn("rounded-md border p-1.5 disabled:opacity-50", viewerVote === "abstain" ? "border-muted-foreground/60 bg-muted-foreground/15 text-foreground" : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-foreground")}
          >
            <MinusCircle className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!perms.castVote || voting != null}
            onClick={() => vote("no")}
            className={cn("rounded-md border p-1.5 disabled:opacity-50", viewerVote === "no" ? "border-down/60 bg-down/15 text-down" : "border-[hsl(var(--glass-border))] text-muted-foreground hover:text-down")}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
          <span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {tally.yes} for / {tally.no} against · majority {IC_MAJORITY_REQUIRED_YES} of {IC_COMMITTEE_SIZE}
            {majorityMet ? <span className="ml-1 text-up">· passed</span> : null}
          </span>
        </div>
        {manualDecisionEnabled && <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!perms.approveNote || busyAny || !manualRejectReady}
            onClick={() => go(note.id, "rejected", onChanged, "IC rejected")}
            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--glass-border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--foreground)/0.05)] disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Reject
          </button>
          <button
            type="button"
            disabled={!canCombinedApprove || busyAny || !manualApproveReady}
            onClick={handleApprove}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> {approveLabel}
          </button>
        </div>}
      </div>
    </div>
  );
}
