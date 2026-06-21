"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, AlertTriangle, Check } from "lucide-react";
import { toast } from "sonner";
import { PersonaRealDataGate } from "@/components/oems/persona-real-data-gate";
import { GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <GlassKpi
            label="Pending recon legs"
            value={pendingReconCount.toString()}
            sub="FILLED, awaiting IPS booking"
          />
          <GlassKpi
            label="Cash positions out of band"
            value={pendingCash.toString()}
            sub="drift > R2m vs target"
          />
          <GlassKpi
            label="Recon exceptions"
            value={reconExceptions.length.toString()}
            sub="open items, ops to action"
          />
          <GlassKpi
            label="Booked today"
            value={Object.values(booked).filter(Boolean).length.toString()}
            sub="via Mark booked (mock)"
            accent="positive"
          />
        </div>

        <div className="grid grid-cols-12 gap-3">
          <GlassSection
            title="Daily reconciliation"
            endpoint="GET IPS /IPSTransactionGetByAccount5?status=PENDING_BOOKING"
            db="retail"
            dataSource="iress"
            right={<Pill tone="warning" size="xs">{pendingReconCount} legs</Pill>}
            className="col-span-12 lg:col-span-7"
            noPadding
          >
            <div className="max-h-[400px] overflow-y-auto scrollbar-thin">
              <table className="w-full font-mono text-[11px]">
                <thead className="sticky top-0 bg-[hsl(var(--glass-bg-strong))] text-[9.5px] uppercase tracking-wider text-muted-foreground backdrop-blur-sm">
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
                <tbody className="divide-y divide-[hsl(var(--glass-border))]">
                  {reconLegs.map((l) => {
                    const isBooked = booked[l.id];
                    return (
                      <tr key={l.id} className="hover:bg-[hsl(var(--foreground)/0.03)]">
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
            </div>
          </GlassSection>

          <GlassSection
            title="Cash positions"
            endpoint="GET IPS /IPSAccountGetAll1"
            db="retail"
            dataSource="iress"
            right={<Pill tone="info" size="xs">{cashPositions.length} accounts</Pill>}
            className="col-span-12 lg:col-span-5"
            noPadding
          >
            <ul className="max-h-[400px] divide-y divide-[hsl(var(--glass-border))] overflow-y-auto scrollbar-thin">
              {cashPositions.map((c) => {
                const oob = Math.abs(c.drift) > 2_000_000;
                return (
                  <li key={c.id} className="px-3 py-2.5 hover:bg-[hsl(var(--foreground)/0.03)]">
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
          </GlassSection>
        </div>

        <GlassSection
          title="Recon exceptions"
          endpoint="GET /v1/finance/recon/exceptions?status=open"
          db="retail"
          dataSource="supabase"
          right={<Pill tone="destructive" size="xs">{reconExceptions.length} open</Pill>}
          noPadding
        >
          <ul className="divide-y divide-[hsl(var(--glass-border))]">
            {reconExceptions.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-[hsl(var(--foreground)/0.03)]">
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
        </GlassSection>

        <div className="flex items-center justify-end">
          <Link href="/oems">
            <Button variant="outline" size="sm" className="glass-inset h-8 border-0 text-[11px]">
              Open OEMS desk
              <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>
    </PersonaRealDataGate>
  );
}
