"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Banknote, AlertTriangle, Check, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PersonaRealDataGate } from "@/components/oems/persona-real-data-gate";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Button } from "@/components/ui/button";
import { reconLegs, cashPositions, reconExceptions } from "@/lib/iress/seed";
import { formatTimeShort, formatZARExact } from "@/lib/format";
import { cn } from "@/lib/cn";

const EXC_CATEGORY_TONE = {
  open_leg:      "warning",
  unmatched_cash: "destructive",
  missing_fill:   "destructive",
  stale_quote:    "info",
} as const;

const EXC_CATEGORY_LABEL = {
  open_leg:      "OPEN LEG",
  unmatched_cash: "UNMATCHED",
  missing_fill:   "MISSING FILL",
  stale_quote:    "STALE",
} as const;

export default function FuneralCoverOverview() {
  const [booked, setBooked] = useState<Record<string, boolean>>({});
  const pendingReconCount = reconLegs.filter((l) => l.status === "PENDING_BOOKING").length;
  const pendingCash = cashPositions.filter((c) => Math.abs(c.drift) > 2_000_000).length;

  function markBooked(id: string, ref: string) {
    setBooked((b) => ({ ...b, [id]: true }));
    toast.success("Marked booked (mock)", { description: ref });
  }

  return (
    <PersonaRealDataGate
      persona="funeral_cover"
      description="Daily reconciliation · cash positions · recon exceptions."
      message="Funeral cover reconciliation requires ops / accounting system integration."
    >
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <KpiTile
            icon={<Banknote className="h-3.5 w-3.5" />}
            label="Pending recon legs"
            value={pendingReconCount.toString()}
            sub="FILLED, awaiting IPS booking"
            tone={pendingReconCount > 0 ? "warning" : "default"}
          />
          <KpiTile
            icon={<Wallet className="h-3.5 w-3.5" />}
            label="Cash positions out of band"
            value={pendingCash.toString()}
            sub="drift > R2m vs target"
            tone={pendingCash > 0 ? "warning" : "default"}
          />
          <KpiTile
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label="Recon exceptions"
            value={reconExceptions.length.toString()}
            sub="open items, ops to action"
            tone={reconExceptions.length > 0 ? "warning" : "default"}
          />
          <KpiTile
            icon={<Check className="h-3.5 w-3.5" />}
            label="Booked today"
            value={Object.values(booked).filter(Boolean).length.toString()}
            sub="via Mark booked (mock)"
            tone="positive"
          />
        </div>

        {/* Row 1: Daily reconciliation | Cash positions */}
        <div className="grid grid-cols-12 gap-2.5">
          <Panel
            title="Daily reconciliation"
            endpoint="GET IPS /IPSTransactionGetByAccount5?status=PENDING_BOOKING"
            right={<Pill tone="warning" size="xs">{pendingReconCount} legs</Pill>}
            className="col-span-12 lg:col-span-7"
            density="scroll"
          >
            <table className="w-full font-mono text-[11px]">
              <thead className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">Time</th>
                  <th className="px-2.5 py-1.5 text-left">Account</th>
                  <th className="px-2.5 py-1.5 text-left">Side</th>
                  <th className="px-2.5 py-1.5 text-left">Sym</th>
                  <th className="px-2.5 py-1.5 text-right">Qty</th>
                  <th className="px-2.5 py-1.5 text-right">Notional</th>
                  <th className="px-2.5 py-1.5 text-left">Status</th>
                  <th className="px-2.5 py-1.5 text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {reconLegs.map((l) => {
                  const isBooked = booked[l.id];
                  return (
                    <tr key={l.id} className="hover:bg-muted/30">
                      <td className="px-2.5 py-1.5 text-muted-foreground">{formatTimeShort(l.ts)}</td>
                      <td className="px-2.5 py-1.5">{l.account}</td>
                      <td className={cn("px-2.5 py-1.5 font-semibold", l.side === "BUY" ? "text-up" : "text-down")}>
                        {l.side}
                      </td>
                      <td className="px-2.5 py-1.5 font-semibold">{l.symbol}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{l.qty.toLocaleString()}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZARExact(l.notional)}</td>
                      <td className="px-2.5 py-1.5">
                        {isBooked ? (
                          <Pill tone="success" size="xs">BOOKED</Pill>
                        ) : (
                          <Pill tone="warning" size="xs">PENDING</Pill>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        {isBooked ? (
                          <span className="font-mono text-[10px] text-muted-foreground">—</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => markBooked(l.id, `${l.account} ${l.side} ${l.symbol}`)}
                            className="h-6 px-2 text-[10px]"
                          >
                            Mark booked
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="Cash positions"
            endpoint="GET IPS /IPSAccountGetAll1"
            right={<Pill tone="info" size="xs">{cashPositions.length} accounts</Pill>}
            className="col-span-12 lg:col-span-5"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {cashPositions.map((c) => {
                const oob = Math.abs(c.drift) > 2_000_000;
                return (
                  <li key={c.id} className="px-3 py-2.5 hover:bg-muted/30">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-medium">{c.account}</p>
                      <Pill tone="neutral" size="xs">{c.currency}</Pill>
                    </div>
                    <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[10.5px]">
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Current</p>
                        <p className="tabular-nums">{formatZARExact(c.current)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Target</p>
                        <p className="tabular-nums">{formatZARExact(c.target)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Drift</p>
                        <p className={cn("tabular-nums", oob ? "text-warning" : c.drift === 0 ? "text-muted-foreground" : "text-foreground")}>
                          {c.drift >= 0 ? "+" : ""}{formatZARExact(c.drift)}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>

        {/* Row 2: Recon exceptions */}
        <Panel
          title="Recon exceptions"
          endpoint="GET /v1/finance/recon/exceptions?status=open"
          right={<Pill tone="destructive" size="xs">{reconExceptions.length} open</Pill>}
        >
          <ul className="divide-y divide-border/60">
            {reconExceptions.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30">
                <AlertTriangle
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    e.severity === "high" ? "text-destructive" :
                    e.severity === "medium" ? "text-warning" : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Pill tone={EXC_CATEGORY_TONE[e.category]} size="xs">{EXC_CATEGORY_LABEL[e.category]}</Pill>
                    <p className="text-xs">{e.description}</p>
                  </div>
                  <p className="mt-0.5 font-mono text-[9.5px] text-muted-foreground">
                    ref {e.ref} · {new Date(e.ts).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" })}
                  </p>
                </div>
                <Pill
                  tone={e.severity === "high" ? "destructive" : e.severity === "medium" ? "warning" : "neutral"}
                  size="xs"
                >
                  {e.severity.toUpperCase()}
                </Pill>
              </li>
            ))}
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
