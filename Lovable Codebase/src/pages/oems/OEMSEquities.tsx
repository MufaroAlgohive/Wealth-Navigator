import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, ArrowDownRight, Lock, ShieldCheck, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { oemsStrategies, jseTopMovers, formatZAR, formatPct, canRebalance, generateIntraday } from "@/lib/oemsData";
import { LineChart, Line, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

export default function OEMSEquities() {
  const equities = oemsStrategies.filter(s => s.kind === "equity");
  const totalAum = equities.reduce((s, x) => s + x.aum, 0);
  const totalPnl = equities.reduce((s, x) => s + x.dayPnl, 0);
  const investors = equities.reduce((s, x) => s + x.investorCount, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniTile label="Equity AUM"    value={formatZAR(totalAum)} sub={`${equities.length} mandates`} />
        <MiniTile label="Day P&L"        value={formatZAR(totalPnl)} sub={formatPct(totalPnl/totalAum*100, 3)} positive={totalPnl >= 0} />
        <MiniTile label="Investors"      value={investors.toString()} sub="across all equity mandates" />
        <MiniTile label="Pre-Trade Checks" value="LIVE" sub="IRIS halt / borrow / non-tradeable" icon={<ShieldCheck className="h-4 w-4 text-success" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {equities.map(s => {
          const series = generateIntraday(100, 50, 0.003);
          const reb = canRebalance(s);
          return (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-sm font-medium">{s.name}</CardTitle>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{s.manager} · {s.holdingsCount} holdings · cash {s.cashWeight}%</p>
                  </div>
                  <Badge variant="secondary" className={cn("text-[10px]", s.status === "live" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>{s.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <ResponsiveContainer width="100%" height={80}>
                  <LineChart data={series}>
                    <Line type="monotone" dataKey="v" stroke={s.dayPnl >= 0 ? "hsl(142, 71%, 45%)" : "hsl(0, 84%, 60%)"} strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <Metric label="AUM" value={s.aum > 0 ? formatZAR(s.aum) : "—"} />
                  <Metric label="YTD" value={formatPct(s.ytd)} positive={s.ytd >= 0} />
                  <Metric label="Sharpe" value={s.sharpe.toFixed(2)} />
                  <Metric label="Max DD" value={formatPct(s.maxDD)} positive={false} />
                  <Metric label="TE" value={s.trackingError?.toFixed(1) + "%" || "—"} />
                  <Metric label="Investors" value={s.investorCount.toString()} />
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <p className="text-[10px] text-muted-foreground font-mono">Last rebal {s.lastRebalanced}</p>
                  <Button size="sm" variant={reb ? "default" : "outline"} disabled={!reb} className="h-7 text-[10px]">
                    {reb ? <><Activity className="h-3 w-3 mr-1" />Rebalance</> : <><Lock className="h-3 w-3 mr-1" />{s.investorCount === 0 ? "No investors" : "Halted"}</>}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">JSE Top Movers</CardTitle>
            <p className="text-xs text-muted-foreground">Live Level 1 quotes · IRIS /v1/securities/quotes</p>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">L1 · DELAYED 0s</Badge>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Sym</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Sector</th>
                  <th className="px-3 py-2 font-medium text-right">Last</th>
                  <th className="px-3 py-2 font-medium text-right">Bid / Ask</th>
                  <th className="px-3 py-2 font-medium text-right">VWAP</th>
                  <th className="px-3 py-2 font-medium text-right">Vol</th>
                  <th className="px-3 py-2 font-medium text-right">Chg %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jseTopMovers.map(i => (
                  <tr key={i.symbol} className="hover:bg-secondary/30 font-mono">
                    <td className="px-4 py-2 font-semibold">{i.symbol}</td>
                    <td className="px-3 py-2 font-sans">{i.name}</td>
                    <td className="px-3 py-2 font-sans text-muted-foreground">{i.sector}</td>
                    <td className="px-3 py-2 text-right">{i.last.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{i.bid.toFixed(2)} / {i.ask.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">{i.vwap.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{(i.volume / 1000).toFixed(0)}k</td>
                    <td className={cn("px-3 py-2 text-right", i.changePct >= 0 ? "text-success" : "text-destructive")}>
                      <span className="inline-flex items-center gap-0.5">{i.changePct >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}{formatPct(i.changePct)}</span>
                    </td>
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

function MiniTile({ label, value, sub, positive, icon }: { label: string; value: string; sub?: string; positive?: boolean; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>{icon}</div>
        <p className="text-xl font-semibold font-mono mt-2">{value}</p>
        {sub && <p className={cn("text-[10px] font-mono mt-0.5", positive === true && "text-success", positive === false && "text-destructive", positive === undefined && "text-muted-foreground")}>{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
      <p className={cn("font-mono font-medium", positive === true && "text-success", positive === false && "text-destructive")}>{value}</p>
    </div>
  );
}
