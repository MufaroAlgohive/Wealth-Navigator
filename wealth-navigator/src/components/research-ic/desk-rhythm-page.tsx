"use client";

/**
 * Desk Rhythm — static reference page. The daily operating cadence of the
 * 3-person institutional desk (FM · COO · Analyst): who owns what, the
 * hour-by-hour schedule, and how the Research → IC → Rebalance workflow ties
 * together. Content mirrors the OEMS design 1:1.
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type * as React from "react";

import { GlassSection, ResearchLabCanvas } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";

type Role = "FM" | "COO" | "ANALYST";

const ROLE_TONE: Record<Role, string> = {
  FM: "border-primary/35 bg-primary/10 text-primary",
  COO: "border-amber-400/40 bg-amber-400/12 text-amber-500",
  ANALYST: "border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.12)] text-up",
};

// Timeline spine accent per owner — turns the flat slot list into a scannable
// backbone that also encodes who owns the slot at a glance.
const ROLE_SPINE: Record<Role, string> = {
  FM: "border-primary/40",
  COO: "border-amber-400/40",
  ANALYST: "border-[hsl(var(--up)/0.40)]",
};

const OWNERS: { initials: string; name: string; title: string; owns: string; role: Role }[] = [
  {
    initials: "YO",
    name: "You",
    title: "Fund Manager / CIO",
    owns: "portfolio construction, execution, IC chair",
    role: "FM",
  },
  {
    initials: "TM",
    name: "T. Molefe",
    title: "Chief Operating Officer",
    owns: "risk, ops, reconciliation, compliance",
    role: "COO",
  },
  {
    initials: "LN",
    name: "L. Ndlovu",
    title: "Junior Analyst",
    owns: "research, morning/evening notes, data",
    role: "ANALYST",
  },
];

interface Slot {
  time: string;
  who: string; // "LN · ANALYST"
  role: Role;
  target: string;
  detail: string;
}
interface Block {
  title: string;
  range: string;
  slots: Slot[];
}

const SCHEDULE: Block[] = [
  {
    title: "Pre-market",
    range: "06:30 – 08:30",
    slots: [
      {
        time: "06:30",
        who: "LN · ANALYST",
        role: "ANALYST",
        target: "News & SENS",
        detail: "Overnight news sweep — SENS, Reuters, Bloomberg. Flag anything hitting research names.",
      },
      {
        time: "07:00",
        who: "LN · ANALYST",
        role: "ANALYST",
        target: "Research → Morning Note",
        detail:
          "Compile Morning Note — 5 bullets: overnight moves, macro today, name-specific catalysts, IC agenda, open triggers hit.",
      },
      {
        time: "07:30",
        who: "YO · FM",
        role: "FM",
        target: "Cockpit → Alerts",
        detail: "Read Morning Note; annotate action items. Review any trigger alerts fired overnight.",
      },
      {
        time: "08:00",
        who: "TM · COO",
        role: "COO",
        target: "Blotter → EOD Recon",
        detail: "Reconcile prior-day executions vs blotter; check cash & margin; sign off pre-market.",
      },
      {
        time: "08:15",
        who: "YO · FM",
        role: "FM",
        target: "",
        detail: "Desk huddle — 15min stand-up. Confirm order pad, IC prep if today.",
      },
    ],
  },
  {
    title: "Open & morning session",
    range: "09:00 – 12:00",
    slots: [
      {
        time: "09:00",
        who: "YO · FM",
        role: "FM",
        target: "Blotter",
        detail: "JSE open. Work open orders (VWAP/POV algos). Monitor trigger fires.",
      },
      {
        time: "10:00",
        who: "LN · ANALYST",
        role: "ANALYST",
        target: "Research → Fundamentals",
        detail: "Fundamentals refresh on any name reporting results today. Update Fundamentals tab.",
      },
      {
        time: "11:00",
        who: "YO · FM",
        role: "FM",
        target: "Strategies",
        detail: "Mid-morning P&L attribution vs benchmark. Flag drift > 50bps.",
      },
    ],
  },
  {
    title: "Midday & IC prep",
    range: "12:00 – 14:00",
    slots: [
      {
        time: "12:00",
        who: "LN · ANALYST",
        role: "ANALYST",
        target: "Research",
        detail: "Deep-work window — one full research refresh per day (rotating).",
      },
      {
        time: "13:00",
        who: "YO · FM",
        role: "FM",
        target: "Committee → Agenda",
        detail:
          "IC prep (Tue/Thu only) — review submitted proposals, pre-read notes, prepare challenge questions.",
      },
    ],
  },
  {
    title: "US open overlap",
    range: "15:30 – 17:00",
    slots: [
      {
        time: "15:30",
        who: "YO · FM",
        role: "FM",
        target: "Blotter + Macro",
        detail: "US open. Work Global Quality orders. Watch macro prints (NFP, CPI).",
      },
      {
        time: "16:15",
        who: "TM · COO",
        role: "COO",
        target: "Cockpit → Risk",
        detail: "Intraday risk snapshot — VaR, sector exposure, concentration.",
      },
    ],
  },
  {
    title: "Close & evening",
    range: "17:00 – 19:00",
    slots: [
      {
        time: "17:05",
        who: "YO · FM",
        role: "FM",
        target: "Strategies",
        detail: "JSE close print. Sign off end-of-day P&L attribution.",
      },
      {
        time: "17:30",
        who: "TM · COO",
        role: "COO",
        target: "Blotter → EOD",
        detail: "Executions → custodian; feed reconciliations kick off; break checks.",
      },
      {
        time: "18:00",
        who: "LN · ANALYST",
        role: "ANALYST",
        target: "Research → Evening Note",
        detail: "Evening Note — tomorrow's calendar, expected catalysts, IC agenda if Tue/Thu.",
      },
      {
        time: "18:30",
        who: "YO · FM",
        role: "FM",
        target: "Cockpit → Alerts",
        detail: "Read Evening Note; set triggers for overnight moves; set alerts.",
      },
    ],
  },
  {
    title: "Investment Committee (Tue/Thu)",
    range: "14:00 – 15:00",
    slots: [
      {
        time: "14:00",
        who: "YO · FM",
        role: "FM",
        target: "Committee",
        detail: "IC session — chair. Walk each proposal: thesis, valuation, triggers, risk. Vote logged.",
      },
      {
        time: "14:45",
        who: "TM · COO",
        role: "COO",
        target: "Committee → Minutes",
        detail: "Minutes & action items. Approved proposals move to Rebalance queue.",
      },
    ],
  },
];

const WORKFLOW: { id: string; body: React.ReactNode }[] = [
  {
    id: "note",
    body: (
      <>
        <b>Analyst</b> initiates or refreshes a{" "}
        <Link href="/oems/research" className="text-primary hover:underline">
          Research Note
        </Link>{" "}
        — thesis, fundamentals, valuation vs peers, mgmt view, triggers.
      </>
    ),
  },
  {
    id: "review",
    body: (
      <>
        <b>FM</b> reviews, sets rating &amp; TP, submits to the{" "}
        <Link href="/oems/committee" className="text-primary hover:underline">
          Investment Committee
        </Link>
        .
      </>
    ),
  },
  {
    id: "vote",
    body: "Committee (Tue/Thu 14:00) votes. Approved notes become eligible for portfolio decisions.",
  },
  {
    id: "builder",
    body: (
      <>
        FM opens the{" "}
        <Link href="/oems/rebalance" className="text-primary hover:underline">
          Rebalance Builder
        </Link>
        , proposes changes — every ADD / INCREASE must reference an approved note.
      </>
    ),
  },
  { id: "ratify", body: "IC ratifies the rebalance proposal." },
  {
    id: "engine",
    body: "Approved proposal flows to the existing Rebalance Engine which cascades to underlying investors.",
  },
  {
    id: "triggers",
    body: "All triggers live-monitor prices — hits push alerts to the FM & log to the note's IC history.",
  },
];

export function DeskRhythmPage() {
  return (
    <ResearchLabCanvas>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Desk Operating Rhythm</h1>
        <p className="text-caption">
          The daily cadence — what a 3-person institutional desk (FM · COO · Analyst) does hour by hour.
        </p>
      </header>

      <GlassSection title="Team & Ownership" dataSource="seed">
        <div className="grid gap-4 md:grid-cols-3">
          {OWNERS.map((o) => (
            <div key={o.initials} className="glass-inset rounded-xl p-4">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border text-xs font-semibold",
                    ROLE_TONE[o.role],
                  )}
                >
                  {o.initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{o.name}</p>
                  <p className="truncate text-caption">{o.title}</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                <span className="font-semibold uppercase tracking-wide">Owns:</span> {o.owns}
              </p>
            </div>
          ))}
        </div>
      </GlassSection>

      <div className="grid gap-5 lg:grid-cols-2">
        {SCHEDULE.map((block) => (
          <GlassSection
            key={block.title}
            title={block.title}
            right={<span className="font-mono text-xs text-muted-foreground">{block.range}</span>}
          >
            <ol className="space-y-3">
              {block.slots.map((s, i) => (
                <li key={`${block.title}-${i}`} className="flex gap-3">
                  <span className="mt-0.5 w-12 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {s.time}
                  </span>
                  <div className={cn("min-w-0 flex-1 space-y-1 border-l-2 pl-3", ROLE_SPINE[s.role])}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          ROLE_TONE[s.role],
                        )}
                      >
                        {s.who}
                      </span>
                      {s.target && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <ArrowRight className="h-3 w-3" />
                          {s.target}
                        </span>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/85">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </GlassSection>
        ))}
      </div>

      <GlassSection title="How the workflow ties together">
        <ol className="space-y-2.5">
          {WORKFLOW.map((w, i) => (
            <li key={w.id} className="flex gap-3 text-sm leading-relaxed">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              <span className="text-foreground/85">{w.body}</span>
            </li>
          ))}
        </ol>
      </GlassSection>
    </ResearchLabCanvas>
  );
}
