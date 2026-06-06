import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Lock, Banknote, TrendingUp, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { oemsStrategies, mmInstruments, jibarFixings, zarYieldCurve, formatZAR, formatPct, canRebalance } from "@/lib/oemsData";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, Area, Bar } from "recharts";

export default function OEMSMoneyMarket() {
  const mm = oemsStrategies.filter(s => s.kind === "money_market");
  const totalAum = mm.reduce((s, x) => s + x.aum, 0);
  const wYield = mm.reduce((s, x) => s + (x.weightedAvgYield ?? 0) * x.aum, 0) / (totalAum || 1);
  const wDur   = mm.reduce((s, x) => s + (x.weightedAvgDuration ?? 0) * x.aum, 0) / (totalAum || 1);

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MiniTile label="MM AUM"          value={formatZAR(totalAum)}              sub={`${mm.length} mandates`} icon={<Banknote className="h-4 w-4 text-primary" />} />
        <MiniTile label="Weighted Yield"  value={`${wYield.toFixed(2)}%`}          sub="net of fees" />
        <MiniTile label="Weighted Dur."   value={`${wDur.toFixed(2)}y`}            sub="effective duration" />
        <MiniTile label="JIBAR 3M"        value={`${jibarFixings[2].rate.toFixed(2)}%`} sub="SARB fixing 11:00" />
        <MiniTile label="Credit Limits"   value="OK" sub="all issuers within band" icon={<ShieldCheck className="h-4 w-4 text-success" />} />
      </div>

      {/* Strategy cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {mm.map(s => {
          const reb = canRebalance(s);
          return (
            <Card key={s.id} className="border-l-2 border-l-warning">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-sm font-medium flex items-center gap-2">{s.name}{s.id === "mm-001" && <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">NEW · INSTITUTIONAL</Badge>}</CardTitle>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{s.manager} · {s.holdingsCount} instruments · {s.benchmark}</p>
                  </div>
                  <Badge variant="secondary" className={cn("text-[10px]", s.status === "live" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>{s.status}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-3 text-xs">
                  <Metric label="AUM"      value={s.aum > 0 ? formatZAR(s.aum) : "—"} />
                  <Metric label="YTD"      value={formatPct(s.ytd)} positive={s.ytd >= 0} />
                  <Metric label="Yield"    value={`${s.weightedAvgYield?.toFixed(2)}%`} />
                  <Metric label="Duration" value={`${s.weightedAvgDuration?.toFixed(2)}y`} />
                  <Metric label="Investors" value={s.investorCount.toString()} />
                  <Metric label="Cash"     value={`${s.cashWeight}%`} />
                  <Metric label="Sharpe"   value={s.sharpe.toFixed(2)} />
                  <Metric label="Max DD"   value={formatPct(s.maxDD)} positive={false} />
                </div>
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
                  <p className="text-[10px] text-muted-foreground font-mono">Last rebal {s.lastRebalanced} · NAV strikes 16:00 SAST</p>
                  <Button size="sm" variant={reb ? "default" : "outline"} disabled={!reb} className="h-7 text-[10px]">
                    {reb ? <><Activity className="h-3 w-3 mr-1" />Rebalance</> : <><Lock className="h-3 w-3 mr-1" />{s.investorCount === 0 ? "No investors" : "Halted"}</>}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* JIBAR + Yield Curve */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">JIBAR Fixings</CardTitle><p className="text-xs text-muted-foreground">SARB · IRIS mirror within 60s</p></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border">
                {jibarFixings.map(f => (
                  <tr key={f.tenor}>
                    <td className="px-4 py-2 font-medium">{f.tenor}</td>
                    <td className="px-3 py-2 text-right font-mono">{f.rate.toFixed(2)}%</td>
                    <td className={cn("px-4 py-2 text-right font-mono text-[10px]", f.change > 0 ? "text-success" : f.change < 0 ? "text-destructive" : "text-muted-foreground")}>
                      {f.change > 0 ? "+" : ""}{(f.change * 100).toFixed(0)}bp
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" />ZAR Sovereign Yield Curve</CardTitle><p className="text-xs text-muted-foreground">Nelson-Siegel-Svensson fit · IRIS /v1/yieldcurve/zar</p></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={zarYieldCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="tenor" tick={{ fontSize: 10 }} stroke="hsl(220, 9%, 46%)" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(220, 9%, 46%)" unit="%" domain={['dataMin - 0.5', 'dataMax + 0.5']} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number) => `${v.toFixed(2)}%`} />
                <Line type="monotone" dataKey="yield" stroke="hsl(38, 92%, 50%)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Eligible MM Instruments */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Eligible Money Market Instruments</CardTitle>
            <p className="text-xs text-muted-foreground">Universe filtered by mandate constraints · IRIS /v1/securities</p>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">{mmInstruments.length} ELIGIBLE</Badge>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Ticker</th>
                  <th className="px-3 py-2 font-medium">Instrument</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Issuer</th>
                  <th className="px-3 py-2 font-medium">Tenor</th>
                  <th className="px-3 py-2 font-medium">Rating</th>
                  <th className="px-3 py-2 font-medium text-right">Yield</th>
                  <th className="px-3 py-2 font-medium text-right">Duration</th>
                  <th className="px-3 py-2 font-medium text-right">Notional</th>
                  <th className="px-3 py-2 font-medium">Maturity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {mmInstruments.map(i => (
                  <tr key={i.ticker} className="hover:bg-secondary/30 font-mono">
                    <td className="px-4 py-2 font-semibold">{i.ticker}</td>
                    <td className="px-3 py-2 font-sans">{i.name}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="text-[10px]">{i.type}</Badge></td>
                    <td className="px-3 py-2 font-sans text-muted-foreground">{i.issuer}</td>
                    <td className="px-3 py-2">{i.tenor}</td>
                    <td className="px-3 py-2"><Badge variant="secondary" className="text-[10px] bg-success/10 text-success">{i.rating}</Badge></td>
                    <td className="px-3 py-2 text-right font-semibold">{i.yield.toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{i.duration.toFixed(2)}y</td>
                    <td className="px-3 py-2 text-right">{formatZAR(i.notional)}</td>
                    <td className="px-3 py-2 font-sans text-muted-foreground">{i.maturity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MiniTile({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>{icon}</div>
        <p className="text-xl font-semibold font-mono mt-2">{value}</p>
        {sub && <p className="text-[10px] font-mono mt-0.5 text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
      <p className={cn("font-mono font-medium text-sm", positive === true && "text-success", positive === false && "text-destructive")}>{value}</p>
    </div>
  );
}
