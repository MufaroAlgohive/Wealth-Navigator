import PanelFrame from "@/components/oems/PanelFrame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { oemsStrategies, canRebalance, formatZAR, formatPct } from "@/lib/oemsData";
import { strategyHoldings } from "@/lib/oemsExtra";
import { Lock, Users, RefreshCw, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

export default function OEMSStrategies() {
  const [selected, setSelected] = useState(oemsStrategies[0].id);
  const strat = oemsStrategies.find(s => s.id === selected)!;
  const holdings = (strategyHoldings as any)[selected] ?? [];

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Strategies</h1>
        <p className="text-xs text-muted-foreground">Rebalance gated on linked investors · pre-trade mandate &amp; halt checks via IRESS</p>
      </div>

      <div className="grid grid-cols-12 gap-3">
        {/* Strategy cards */}
        <div className="col-span-5 space-y-2">
          {oemsStrategies.map(s => {
            const reb = canRebalance(s);
            const isSel = selected === s.id;
            return (
              <button key={s.id} onClick={() => setSelected(s.id)}
                className={cn("w-full text-left rounded-md border bg-card p-3 transition-all hover:border-primary/40",
                  isSel ? "border-primary ring-1 ring-primary" : "border-border")}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{s.name}</p>
                    <p className="text-[10px] text-muted-foreground">{s.manager} · bench {s.benchmark}</p>
                  </div>
                  <Badge variant="outline" className={cn("text-[9px] font-mono",
                    s.kind === "equity" ? "border-primary/40 text-primary" : "border-warning/40 text-warning")}>
                    {s.kind === "equity" ? "EQUITY" : "MONEY MKT"}
                  </Badge>
                </div>
                <div className="grid grid-cols-4 gap-2 text-[10px]">
                  <div><p className="text-muted-foreground">AUM</p><p className="font-mono font-semibold">{s.aum > 0 ? formatZAR(s.aum) : "—"}</p></div>
                  <div><p className="text-muted-foreground">YTD</p><p className={cn("font-mono font-semibold", s.ytd >= 0 ? "text-success" : "text-destructive")}>{formatPct(s.ytd)}</p></div>
                  <div><p className="text-muted-foreground">Day P&L</p><p className={cn("font-mono font-semibold", s.dayPnl >= 0 ? "text-success" : "text-destructive")}>{s.dayPnl !== 0 ? formatZAR(s.dayPnl) : "—"}</p></div>
                  <div><p className="text-muted-foreground"><Users className="inline h-2.5 w-2.5" /> Inv</p><p className="font-mono font-semibold">{s.investorCount}</p></div>
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                  <Badge variant="secondary" className={cn("text-[9px]",
                    s.status === "live" && "bg-success/10 text-success",
                    s.status === "paper" && "bg-muted text-muted-foreground",
                    s.status === "halted" && "bg-destructive/10 text-destructive")}>{s.status.toUpperCase()}</Badge>
                  <Button size="sm" variant={reb ? "default" : "outline"} disabled={!reb} className="h-6 text-[10px]" onClick={e => e.stopPropagation()}>
                    {reb ? <><RefreshCw className="h-2.5 w-2.5 mr-1" />Rebalance</> : <><Lock className="h-2.5 w-2.5 mr-1" />Locked</>}
                  </Button>
                </div>
              </button>
            );
          })}
        </div>

        {/* Selected detail */}
        <div className="col-span-7 space-y-3">
          <PanelFrame title={`${strat.name} · Detail`} endpoint="INTERNAL + GET /v1/positions">
            <div className="grid grid-cols-4 gap-2 mb-3">
              <KpiTiny label="Sharpe" value={strat.sharpe.toFixed(2)} />
              <KpiTiny label="Max DD" value={formatPct(strat.maxDD)} negative />
              <KpiTiny label="Cash %" value={`${strat.cashWeight.toFixed(1)}%`} />
              <KpiTiny label="Last reb." value={strat.lastRebalanced} />
              {strat.kind === "money_market" && (<>
                <KpiTiny label="WAY" value={`${strat.weightedAvgYield?.toFixed(2)}%`} />
                <KpiTiny label="WAM" value={`${strat.weightedAvgDuration?.toFixed(2)}y`} />
              </>)}
            </div>
            {!canRebalance(strat) && (
              <div className="rounded border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                <span>Rebalance disabled — {strat.investorCount === 0 ? "no underlying investors linked" : "strategy halted"}.</span>
              </div>
            )}
          </PanelFrame>

          <PanelFrame title="Holdings · Target vs Actual" endpoint="GET /v1/positions?strategy={id}" dense scroll className="h-[420px]">
            {holdings.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">No holdings published for this strategy yet.</div>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5">Symbol</th>
                    <th className="text-left px-2">Name</th>
                    <th className="text-right px-2">Qty</th>
                    <th className="text-right px-2">MV</th>
                    <th className="text-right px-2">Target %</th>
                    <th className="text-right px-2">Actual %</th>
                    <th className="px-2 w-[140px]">Drift</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {holdings.map((h: any) => {
                    const drift = h.actual - h.target;
                    return (
                      <tr key={h.symbol}>
                        <td className="px-2 py-1.5 font-medium">{h.symbol}</td>
                        <td className="px-2 text-muted-foreground">{h.name}</td>
                        <td className="px-2 text-right">{h.qty.toLocaleString()}</td>
                        <td className="px-2 text-right">{formatZAR(h.mv)}</td>
                        <td className="px-2 text-right text-muted-foreground">{h.target.toFixed(1)}%</td>
                        <td className="px-2 text-right">{h.actual.toFixed(1)}%</td>
                        <td className="px-2">
                          <div className="flex items-center gap-1.5">
                            <div className="relative h-1.5 flex-1 bg-muted rounded">
                              <div className={cn("absolute top-0 h-full rounded", drift >= 0 ? "left-1/2 bg-success" : "right-1/2 bg-destructive")}
                                style={{ width: `${Math.min(Math.abs(drift) * 10, 50)}%` }} />
                              <div className="absolute top-0 left-1/2 h-full w-px bg-muted-foreground/40" />
                            </div>
                            <span className={cn("text-[9px] w-9 text-right", Math.abs(drift) > 0.5 ? (drift > 0 ? "text-success" : "text-destructive") : "text-muted-foreground")}>
                              {drift >= 0 ? "+" : ""}{drift.toFixed(1)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </PanelFrame>
        </div>
      </div>
    </div>
  );
}

function KpiTiny({ label, value, negative }: { label: string; value: any; negative?: boolean }) {
  return (
    <div className="rounded border border-border bg-card p-2">
      <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={cn("text-sm font-mono font-semibold mt-0.5", negative && "text-destructive")}>{value}</p>
    </div>
  );
}
