"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Shield, Check, X, ScrollText, Users as UsersIcon, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { PersonaRealDataGate } from "@/components/oems/persona-real-data-gate";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { Button } from "@/components/ui/button";
import { pendingApprovals, auditTrail } from "@/lib/iress/seed";
import { PERSONA_USERS, type Persona } from "@/lib/store/session-provider";
import { cn } from "@/lib/cn";

const APPROVAL_TONE = {
  suitability:            "primary",
  ip_rebalance:           "warning",
  discretionary_override: "destructive",
  mandate_signoff:        "info",
} as const;

const APPROVAL_LABEL = {
  suitability:            "SUITABILITY",
  ip_rebalance:           "IP REBAL",
  discretionary_override: "OVERRIDE",
  mandate_signoff:        "MANDATE",
} as const;

const PERSONA_DESCRIPTIONS: Record<Persona, string> = {
  oems:           "Full OEMS access — trading, blotter, strategies, FIX+.",
  wealth_manager: "Client books, suitability, performance, rebalance proposals.",
  strategist:     "Strategy design, mandate templates, performance attribution.",
  admin:          "Approvals, audit, user & role access, IRESS credentials.",
  business:       "House view performance, pipeline, sales reporting.",
  funeral_cover:  "Policies, claims, underwriting, broker management.",
};

export default function AdminPage() {
  const [decided, setDecided] = useState<Record<string, "approved" | "rejected" | undefined>>({});
  const [openPersona, setOpenPersona] = useState<Persona | null>(null);

  function decide(id: string, title: string, verdict: "approved" | "rejected") {
    setDecided((d) => ({ ...d, [id]: verdict }));
    toast.success(verdict === "approved" ? "Approved (mock)" : "Rejected (mock)", {
      description: title,
    });
  }

  return (
    <PersonaRealDataGate
      persona="admin"
      description="Pending approvals · audit trail · user & role access."
      message="Admin approvals and audit trail require compliance / ops system integration."
      endpoint="Compliance / ops system"
    >
        {/* Row 1: Pending approvals | Audit trail */}
        <div className="grid grid-cols-12 gap-2.5">
          <Panel
            title="Pending approvals"
            endpoint="GET /v1/compliance/approvals?status=pending"
            right={<Pill tone="warning" size="xs">{pendingApprovals.length} pending</Pill>}
            className="col-span-12 lg:col-span-7"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {pendingApprovals.map((a) => {
                const verdict = decided[a.id];
                return (
                  <li key={a.id} className="px-3 py-2.5 hover:bg-muted/30">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <Pill tone={APPROVAL_TONE[a.kind]} size="xs">{APPROVAL_LABEL[a.kind]}</Pill>
                          <p className="truncate text-xs font-medium">{a.title}</p>
                        </div>
                        {a.notes && (
                          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{a.notes}</p>
                        )}
                        <p className="mt-0.5 font-mono text-[9.5px] text-muted-foreground">
                          by {a.submittedBy} · {new Date(a.submittedAt).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" })}
                        </p>
                      </div>
                      {verdict ? (
                        <Pill tone={verdict === "approved" ? "success" : "destructive"} size="xs">
                          {verdict === "approved" ? "APPROVED" : "REJECTED"}
                        </Pill>
                      ) : (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="success"
                            onClick={() => decide(a.id, a.title, "approved")}
                            className="h-6 px-2 text-[10px]"
                          >
                            <Check className="h-3 w-3" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => decide(a.id, a.title, "rejected")}
                            className="h-6 px-2 text-[10px]"
                          >
                            <X className="h-3 w-3" /> Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel
            title="Audit trail"
            endpoint="GET /v1/audit?limit=10"
            right={<span className="font-mono text-[10px]">last 7 events</span>}
            className="col-span-12 lg:col-span-5"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {auditTrail.map((e) => (
                <li key={e.id} className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30">
                  <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
                    {new Date(e.ts).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" })}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">
                      <span className="font-medium">{e.actor}</span>
                      <span className="text-muted-foreground"> {e.action} </span>
                      {e.target && <span className="font-mono text-foreground/90">{e.target}</span>}
                    </p>
                    {e.notes && (
                      <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{e.notes}</p>
                    )}
                  </div>
                  <Pill
                    tone={
                      e.tone === "success" ? "success" :
                      e.tone === "warning" ? "warning" :
                      e.tone === "destructive" ? "destructive" : "info"
                    }
                    size="xs"
                  >
                    {e.tone === "destructive" ? "REJ" : e.tone.toUpperCase()}
                  </Pill>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* Row 2: User & role access */}
        <Panel
          title="User & role access"
          endpoint="GET /v1/iam/users"
          right={<Pill tone="info" size="xs">{Object.keys(PERSONA_USERS).length} personas</Pill>}
        >
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {(Object.keys(PERSONA_USERS) as Persona[]).map((p) => {
              const u = PERSONA_USERS[p];
              const open = openPersona === p;
              return (
                <li key={p} className="rounded-md border border-border/60 bg-surface-2/30">
                  <button
                    type="button"
                    onClick={() => setOpenPersona(open ? null : p)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{u.name}</p>
                      <p className="truncate text-[10.5px] text-muted-foreground">{u.subtitle} · {u.role}</p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>
                  {open && (
                    <div className="border-t border-border/60 px-3 py-2 text-[10.5px] text-muted-foreground">
                      {PERSONA_DESCRIPTIONS[p]}
                    </div>
                  )}
                  {!open && (
                    <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5">
                      <Pill tone="neutral" size="xs">{u.id}</Pill>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenPersona(p)}
                        className="h-5 px-1.5 text-[10px] text-muted-foreground"
                      >
                        View permissions
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>

        {/* Secondary action */}
        <div className="flex items-center justify-end pt-1">
          <Link href="/oems">
            <Button variant="outline" size="sm" className="h-7 text-[11px]">
              Open OEMS desk
              <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>
    </PersonaRealDataGate>
  );
}
