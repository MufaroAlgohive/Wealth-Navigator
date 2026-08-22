"use client";

import { Users } from "lucide-react";
import * as React from "react";

type Scope = "live" | "uat";
type Member = { voter_email: string; display_name: string; initials: string | null; role: "chair" | "voting" | "observer"; vote_scope: Array<"rebalance" | "research"> };
type Governance = { members: Member[]; policy: { approval_mode: "count" | "percentage"; required_yes_count: number; required_yes_percent: number } };

export function CommitteeRightRail({ scope, canSeeUat, compact = false }: { scope: Scope; canSeeUat: boolean; compact?: boolean }) {
  const [data, setData] = React.useState<Partial<Record<Scope, Governance>>>({});
  React.useEffect(() => { fetch("/api/research/committee/governance", { cache: "no-store" }).then((r) => r.json()).then((j) => j.ok && setData(j.scopes ?? {})).catch(() => undefined); }, []);
  const g = data[scope];
  const required = g?.policy.approval_mode === "percentage" ? `${g.policy.required_yes_percent}% yes` : `${g?.policy.required_yes_count ?? 2} yes votes`;
  // Density matches the Fundamentals/Valuation/IC-log treatment from
  // PR #148 (text-[9px] labels, text-[11px] body, tighter padding/gaps) —
  // the container-level self-start/h-fit fix (also from #148) stops this
  // rail stretching to match its taller sibling, but the panels' OWN
  // padding/spacing was still the pre-#148 default and looked oversized
  // for 3 rows of content. p-3.5→p-2.5, h-7 avatar→h-5, text-xs name→11px,
  // text-[10px] role→9px, space-y-2.5 rows→1.5.
  return <aside className={compact ? "h-fit space-y-2.5" : "h-fit self-start space-y-2.5 xl:sticky xl:top-20"}>
    <section className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] p-2.5">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-[11px] font-semibold">{scope === "uat" ? "UAT committee" : "Committee members"}</h2><span className="rounded-md border border-[hsl(var(--glass-border))] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{scope}</span></div>
      {!g ? <p className="text-caption">Loading committee…</p> : g.members.length === 0 ? <p className="text-caption">No {scope.toUpperCase()} voters configured yet.</p> : <div className="space-y-1.5">{g.members.map((m) => <div key={m.voter_email} className="flex items-center gap-2"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">{m.initials || m.display_name.slice(0,2).toUpperCase()}</span><div className="min-w-0"><p className="truncate text-[11px] font-medium">{m.display_name}</p><p className="text-[9px] text-muted-foreground">{m.role === "chair" ? "Chair" : m.role === "voting" ? `Voting · ${m.vote_scope.join(" + ")}` : "Observer"}</p></div></div>)}</div>}
    </section>
    <section className="rounded-xl border border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.018)] p-2.5"><div className="mb-1.5 flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-primary"/><h2 className="text-[11px] font-semibold">Voting rule</h2></div><p className="text-[11px] leading-relaxed text-muted-foreground">{required}. {scope === "uat" ? "UAT research and votes are isolated from LIVE." : "LIVE research and votes use this roster only."}</p>{scope === "live" && <p className="mt-1.5 text-[9px] text-muted-foreground">Quorum, pre-read and rebalance gates remain in the IC Agenda.</p>}</section>
    {canSeeUat && scope === "live" && <p className="px-1 text-[9px] text-muted-foreground">UAT committee is available from the UAT Research tab.</p>}
  </aside>;
}
