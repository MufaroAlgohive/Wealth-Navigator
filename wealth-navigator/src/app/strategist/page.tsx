"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, Layers, BookOpen, BarChart3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from "recharts";
import { OEMSShell } from "@/components/oems/shell/oems-shell";
import { CommandPaletteProvider } from "@/components/oems/command-palette";
import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { PersonaHeader } from "@/components/oems/primitives/persona-header";
import { Button } from "@/components/ui/button";
import { oemsStrategies, mandateTemplates } from "@/lib/iress/seed";
import { formatPct, formatZAR } from "@/lib/format";

const STRATEGIST_ID = "st1";

export default function StrategistPage() {
  const myStrategies = useMemo(
    () => oemsStrategies.filter((s) => s.managerId === STRATEGIST_ID),
    [],
  );
  const totalAum = myStrategies.reduce((s, x) => s + x.aum, 0);
  const liveCount = myStrategies.filter((s) => s.status === "live").length;
  const headline = myStrategies[0];

  // Mock YTD attribution for the first strategy (sector + allocation + interaction).
  const attribution = useMemo(
    () => [
      { source: "Sector selection", value:  6.4, fill: "hsl(263 80% 65%)" },
      { source: "Asset allocation", value:  4.8, fill: "hsl(38 95% 56%)" },
      { source: "Interaction",      value:  1.2, fill: "hsl(142 70% 45%)" },
      { source: "Cash drag",        value: -1.4, fill: "hsl(0 0% 60%)" },
    ],
    [],
  );

  return (
    <CommandPaletteProvider>
      <OEMSShell>
        <div className="space-y-3">
        <PersonaHeader
          persona="strategist"
          description="Strategies under your mandate · reusable templates · performance attribution."
        />

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <KpiTile
            icon={<Layers className="h-3.5 w-3.5" />}
            label="Strategies under mandate"
            value={myStrategies.length.toString()}
            sub={`${liveCount} live · ${myStrategies.length - liveCount} paper`}
          />
          <KpiTile
            icon={<Layers className="h-3.5 w-3.5" />}
            label="Mandate AUM"
            value={formatZAR(totalAum)}
            sub="gross, live strategies"
          />
          <KpiTile
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Headline YTD"
            value={headline ? formatPct(headline.ytd, 2) : "—"}
            sub={headline?.name ?? "—"}
            tone={headline && headline.ytd >= 0 ? "positive" : "negative"}
          />
          <KpiTile
            icon={<BookOpen className="h-3.5 w-3.5" />}
            label="Templates available"
            value={mandateTemplates.length.toString()}
            sub="reusable mandate kit"
          />
        </div>

        {/* Row 1: Strategies under mandate | Mandate templates */}
        <div className="grid grid-cols-12 gap-2.5">
          <Panel
            title="Strategies under my mandate"
            endpoint="GET /v1/strategies?managerId=st1"
            right={<span className="font-mono text-[10px]">{myStrategies.length} strategies</span>}
            className="col-span-12 lg:col-span-7"
          >
            <table className="w-full font-mono text-[11px]">
              <thead className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">Strategy</th>
                  <th className="px-2.5 py-1.5 text-left">Kind</th>
                  <th className="px-2.5 py-1.5 text-right">AUM</th>
                  <th className="px-2.5 py-1.5 text-right">YTD</th>
                  <th className="px-2.5 py-1.5 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {myStrategies.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="px-2.5 py-1.5 font-sans text-xs font-medium">
                      <div>{s.name}</div>
                      <div className="text-[9.5px] text-muted-foreground">{s.benchmark}</div>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Pill tone={s.kind === "equity" ? "primary" : "warning"} size="xs">
                        {s.kind === "equity" ? "EQUITY" : "MONEY MKT"}
                      </Pill>
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZAR(s.aum)}</td>
                    <td className={`px-2.5 py-1.5 text-right tabular-nums ${s.ytd >= 0 ? "text-up" : "text-down"}`}>
                      {formatPct(s.ytd, 2)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Pill
                        tone={s.status === "live" ? "success" : s.status === "paper" ? "neutral" : "destructive"}
                        size="xs"
                        dot
                      >
                        {s.status}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="Mandate templates"
            endpoint="GET /v1/mandates/templates"
            right={<Pill tone="info" size="xs">{mandateTemplates.length} kits</Pill>}
            className="col-span-12 lg:col-span-5"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {mandateTemplates.map((t) => (
                <li key={t.id} className="px-3 py-2.5 hover:bg-muted/30">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium">{t.name}</p>
                    <Pill
                      tone={
                        t.risk === "Cautious" ? "info" :
                        t.risk === "Balanced" ? "success" :
                        t.risk === "Growth"   ? "warning" : "destructive"
                      }
                      size="xs"
                    >
                      {t.risk.toUpperCase()}
                    </Pill>
                  </div>
                  <p className="mt-1 text-[10.5px] text-muted-foreground">{t.description}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    <span>Target {formatPct(t.targetReturn, 1)}</span>
                    <span>·</span>
                    <span>Vol {t.volatility.toFixed(1)}%</span>
                    <span>·</span>
                    <span>{t.horizonYears}y horizon</span>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* Row 2: Performance attribution */}
        <Panel
          title={`Performance attribution · YTD · ${headline?.name ?? ""}`}
          endpoint="INTERNAL · Brinson-Fachler decomp"
          right={<span className="font-mono text-[10px]">net of fees · ZAR</span>}
          className="h-[280px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={attribution} layout="vertical" margin={{ top: 8, right: 16, left: 16, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="category"
                dataKey="source"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
                width={130}
              />
              <Tooltip
                contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "Attribution"]}
              />
              <Bar dataKey="value" radius={[0, 2, 2, 0]}>
                {attribution.map((a, i) => (
                  <Cell key={i} fill={a.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
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
      </div>
      </OEMSShell>
    </CommandPaletteProvider>
  );
}
