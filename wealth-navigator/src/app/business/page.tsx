"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { PersonaRealDataGate } from "@/components/oems/persona-real-data-gate";
import { GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";
import { Button } from "@/components/ui/button";
import { oemsStrategies, deals } from "@/lib/iress/seed";
import { formatPct, formatZAR, formatZARExact } from "@/lib/format";
import { cn } from "@/lib/cn";

const SALES_PITCH: Record<string, string> = {
  "eq-001": "Outsourced CIO for SA equity alpha. 18% YTD, 38 client mandates.",
  "eq-002": "Global quality sleeve for our HNW cross-border book.",
  "eq-003": "Resources tilt for clients with cyclical risk tolerance.",
  "eq-004": "Smart beta low-vol in pilot — ready for distribution Q3.",
  "mm-001": "Institutional money-market wrapper. Treasury & pension default.",
  "mm-002": "Enhanced-yield paper, launching alongside new FICA-aligned decks.",
};

const STAGE_TONE = {
  Prospect:   "neutral",
  Discovery:  "info",
  Proposal:   "primary",
  Mandate:    "success",
  KYC:        "warning",
  Closed:     "success",
  Onboarding: "info",
} as const;

const COMPLIANCE_FLAGS = [
  { id: "cf-1", text: "Lerato van der Merwe: annual CPD overdue by 12 days", tone: "destructive" as const },
  { id: "cf-2", text: "Khumalo trust: FICA review due 2026-06-30",           tone: "warning"   as const },
];

export default function BusinessPage() {
  const totalAum = oemsStrategies.reduce((s, x) => s + x.aum, 0);
  const totalClients = oemsStrategies.reduce((s, x) => s + x.investorCount, 0);
  const pipelineValue = useMemo(() => deals.reduce((s, d) => s + d.value, 0), []);
  const weightedPipeline = useMemo(
    () => deals.reduce((s, d) => s + d.value * (d.probability / 100), 0),
    [],
  );

  return (
    <PersonaRealDataGate
      persona="business"
      description="House view performance · sales pipeline · compliance flags."
      message="Business pipeline and house-view KPIs require CRM / sales system integration."
    >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <GlassKpi
            label="House-view AUM"
            value={formatZARExact(totalAum)}
            sub={`${oemsStrategies.length} strategies`}
            accent="primary"
          />
          <GlassKpi
            label="Total client mandates"
            value={totalClients.toString()}
            sub="across all strategies"
          />
          <GlassKpi
            label="Pipeline (weighted)"
            value={formatZAR(weightedPipeline)}
            sub={`${deals.length} open deals · ${formatZAR(pipelineValue)} gross`}
          />
          <GlassKpi
            label="Compliance flags"
            value={COMPLIANCE_FLAGS.length.toString()}
            sub="require action"
          />
        </div>

        <div className="grid grid-cols-12 gap-3">
          <GlassSection
            title="House view performance"
            endpoint="GET /v1/strategies?salesView=true"
            db="retail"
            dataSource="seed"
            right={<Pill tone="info" size="xs">SALES</Pill>}
            className="col-span-12 lg:col-span-7"
            noPadding
          >
            <table className="w-full font-mono text-[11px]">
              <thead className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">Strategy</th>
                  <th className="px-2.5 py-1.5 text-right">AUM</th>
                  <th className="px-2.5 py-1.5 text-right">Clients</th>
                  <th className="px-2.5 py-1.5 text-right">YTD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(var(--glass-border))]">
                {oemsStrategies.map((s) => (
                  <tr key={s.id} className="hover:bg-[hsl(var(--foreground)/0.03)]">
                    <td className="px-2.5 py-1.5 font-sans text-xs">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-[10.5px] italic text-muted-foreground">
                        “{SALES_PITCH[s.id] ?? ""}”
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZARExact(s.aum)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{s.investorCount}</td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", s.ytd >= 0 ? "text-up" : "text-down")}>
                      {formatPct(s.ytd, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassSection>

          <GlassSection
            title="Pipeline"
            endpoint="GET /v1/crm/deals?stage=open"
            db="retail"
            dataSource="seed"
            right={<Pill tone="primary" size="xs">{deals.length} deals</Pill>}
            className="col-span-12 lg:col-span-5"
            noPadding
          >
            <ul className="max-h-[360px] divide-y divide-[hsl(var(--glass-border))] overflow-y-auto scrollbar-thin">
              {deals.map((d) => (
                <li key={d.id} className="px-3 py-2.5 hover:bg-[hsl(var(--foreground)/0.03)]">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium">{d.client}</p>
                    <Pill tone={STAGE_TONE[d.stage]} size="xs">{d.stage.toUpperCase()}</Pill>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    <span>{formatZAR(d.value)}</span>
                    <span>·</span>
                    <span>Owner: {d.owner}</span>
                    <span>·</span>
                    <span>{d.probability}%</span>
                  </div>
                  <p className="mt-1 text-[10.5px] text-muted-foreground">Next: {d.nextAction}</p>
                </li>
              ))}
            </ul>
          </GlassSection>
        </div>

        <GlassSection
          title="Compliance flags"
          endpoint="GET /v1/compliance/flags?scope=business"
          db="retail"
          dataSource="seed"
          right={<Pill tone="warning" size="xs">{COMPLIANCE_FLAGS.length} open</Pill>}
          noPadding
        >
          <ul className="divide-y divide-[hsl(var(--glass-border))]">
            {COMPLIANCE_FLAGS.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-[hsl(var(--foreground)/0.03)]">
                <AlertTriangle
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    f.tone === "destructive" ? "text-destructive" : "text-warning",
                  )}
                />
                <span className="flex-1 text-xs">{f.text}</span>
                <Pill tone={f.tone} size="xs">{f.tone === "destructive" ? "OVERDUE" : "DUE SOON"}</Pill>
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
