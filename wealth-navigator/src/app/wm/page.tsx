"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, Briefcase, ClipboardCheck, History } from "lucide-react";
import { PersonaRealDataGate } from "@/components/oems/persona-real-data-gate";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Button } from "@/components/ui/button";
import { clientsByWealthManager } from "@/lib/iress/seed";
import { formatPct, formatZAR } from "@/lib/format";
import { cn } from "@/lib/cn";

const WM_ID = "wm1";

export default function WMPage() {
  const myClients = useMemo(
    () => clientsByWealthManager.filter((c) => c.wealthManagerId === WM_ID),
    [],
  );
  const topByAum = useMemo(
    () => [...myClients].sort((a, b) => b.aum - a.aum).slice(0, 5),
    [myClients],
  );
  const totalAum = myClients.reduce((s, c) => s + c.aum, 0);
  const avgYtd = myClients.length
    ? myClients.reduce((s, c) => s + c.ytd, 0) / myClients.length
    : 0;
  const suitabilityQueue = myClients.slice(0, 3);
  const activity = [
    { time: "11:42", text: "Mokoena household: withdrew R 250,000", tone: "warning" as const },
    { time: "10:18", text: "Khumalo trust: rebalance requested",    tone: "primary" as const },
    { time: "09:05", text: "Dlamini holdings: proposal accepted",    tone: "success" as const },
  ];

  return (
    <PersonaRealDataGate
      persona="wealth_manager"
      description="Your client book · suitability queue · activity today. Use the OEMS desk to act on any item."
      message="Wealth manager client book requires CRM integration."
    >
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <KpiTile
            icon={<Briefcase className="h-3.5 w-3.5" />}
            label="Book AUM"
            value={formatZAR(totalAum)}
            sub={`${myClients.length} clients`}
          />
          <KpiTile
            icon={<ClipboardCheck className="h-3.5 w-3.5" />}
            label="Suitability reviews"
            value={suitabilityQueue.length.toString()}
            sub="due this month"
            tone={suitabilityQueue.length > 0 ? "warning" : "default"}
          />
          <KpiTile
            icon={<History className="h-3.5 w-3.5" />}
            label="Book YTD (avg)"
            value={formatPct(avgYtd, 2)}
            sub="simple average per mandate"
            tone={avgYtd >= 0 ? "positive" : "negative"}
          />
          <KpiTile
            icon={<Briefcase className="h-3.5 w-3.5" />}
            label="Top client"
            value={topByAum[0] ? formatZAR(topByAum[0].aum) : "—"}
            sub={topByAum[0]?.name ?? ""}
          />
        </div>

        {/* Row 1: My Client Book | Suitability reviews */}
        <div className="grid grid-cols-12 gap-2.5">
          <Panel
            title="My Client Book · Top 5 by AUM"
            endpoint="GET /v1/clients?wealthManagerId=wm1"
            right={<span className="font-mono text-[10px]">{myClients.length} total</span>}
            className="col-span-12 lg:col-span-7"
          >
            <table className="w-full font-mono text-[11px]">
              <thead className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">Client</th>
                  <th className="px-2.5 py-1.5 text-left">Mandate</th>
                  <th className="px-2.5 py-1.5 text-right">AUM</th>
                  <th className="px-2.5 py-1.5 text-right">MTD</th>
                  <th className="px-2.5 py-1.5 text-right">YTD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {topByAum.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="px-2.5 py-1.5 font-sans text-xs font-medium">{c.name}</td>
                    <td className="px-2.5 py-1.5">
                      <Pill tone="neutral" size="xs">{c.mandate}</Pill>
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZAR(c.aum)}</td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", c.mtd >= 0 ? "text-up" : "text-down")}>
                      {formatPct(c.mtd, 2)}
                    </td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", c.ytd >= 0 ? "text-up" : "text-down")}>
                      {formatPct(c.ytd, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="Pending suitability reviews"
            endpoint="GET /v1/suitability/queue?assignee=wm1"
            right={
              <Pill tone="warning" size="xs">{suitabilityQueue.length} pending</Pill>
            }
            className="col-span-12 lg:col-span-5"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {suitabilityQueue.map((c) => (
                <li key={c.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs font-medium">{c.name}</p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {c.mandate} · {c.riskProfile} profile · {formatZAR(c.aum)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Pill tone="warning" size="xs">PENDING</Pill>
                    <span className="font-mono text-[9.5px] text-muted-foreground">due {c.nextReviewDate}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* Row 2: Client activity today */}
        <Panel
          title="Client activity today"
          endpoint="GET /v1/clients/activity?assignee=wm1&date=2026-06-06"
          right={<Pill tone="info" size="xs">TODAY</Pill>}
        >
          <ul className="divide-y divide-border/60">
            {activity.map((a) => (
              <li key={a.time} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30">
                <span className="w-14 shrink-0 font-mono text-[10.5px] text-muted-foreground">{a.time} SAST</span>
                <span className="flex-1 text-xs">{a.text}</span>
                <Pill tone={a.tone} size="xs">{a.tone.toUpperCase()}</Pill>
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
