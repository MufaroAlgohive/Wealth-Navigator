import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowUpRight, ArrowDownRight, Activity, AlertTriangle, Lock, TrendingUp, Newspaper, Globe2, Layers, Banknote, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  globalIndices, fxQuotes, commodityQuotes, jseTopMovers, oemsStrategies,
  newsFeed, jibarFixings, zarYieldCurve, macroIndicators, generateIntraday,
  formatZAR, formatPct, canRebalance,
} from "@/lib/oemsData";
import OEMSEquities from "./OEMSEquities";
import OEMSMoneyMarket from "./OEMSMoneyMarket";
import OEMSMacro from "./OEMSMacro";
import OEMSNews from "./OEMSNews";
import OEMSMarket from "./OEMSMarket";
import OEMSIntegration from "./OEMSIntegration";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

const intraday = generateIntraday(87412, 78, 0.0008);

function Ticker() {
  const items = [
    ...globalIndices.slice(0, 6).map(i => ({ k: i.code, v: i.last.toLocaleString("en-ZA", { maximumFractionDigits: 2 }), p: i.changePct })),
    ...fxQuotes.slice(0, 3).map(f => ({ k: f.pair, v: f.last.toFixed(4), p: f.changePct })),
    ...commodityQuotes.slice(0, 3).map(c => ({ k: c.name.split(" ")[0], v: c.last.toFixed(2), p: c.changePct })),
  ];
  return (
    <div className="flex gap-6 overflow-x-auto whitespace-nowrap py-2 px-4 bg-[hsl(225,33%,10%)] text-[hsl(220,20%,90%)] rounded-md border border-[hsl(225,20%,18%)] text-xs font-mono">
      <Wifi className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
      <span className="text-[hsl(220,15%,55%)] shrink-0">IRIS LIVE</span>
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5 shrink-0">
          <span className="text-[hsl(220,15%,65%)]">{it.k}</span>
          <span className="font-medium">{it.v}</span>
          <span className={cn("flex items-center gap-0.5", it.p >= 0 ? "text-success" : "text-destructive")}>
            {it.p >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {it.p >= 0 ? "+" : ""}{it.p.toFixed(2)}%
          </span>
        </span>
      ))}
    </div>
  );
}

function Unified() {
  const totalAum = oemsStrategies.reduce((s, x) => s + x.aum, 0);
  const livePnl  = oemsStrategies.reduce((s, x) => s + x.dayPnl, 0);
  const liveStrats = oemsStrategies.filter(s => s.status === "live").length;
  const blocked = oemsStrategies.filter(s => !canRebalance(s)).length;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={<Layers className="h-4 w-4" />} label="Platform AUM"      value={formatZAR(totalAum)}        sub={`${oemsStrategies.length} strategies · ${liveStrats} live`} />
        <KpiTile icon={<Activity className="h-4 w-4" />} label="Day P&L"          value={formatZAR(livePnl)}         sub={formatPct(livePnl/totalAum*100, 3)} positive={livePnl >= 0} />
        <KpiTile icon={<Lock className="h-4 w-4" />}    label="Rebalance Locked" value={blocked.toString()}          sub="0 investors / halted" warning />
        <KpiTile icon={<Banknote className="h-4 w-4" />} label="JIBAR 3M"         value={`${jibarFixings[2].rate.toFixed(2)}%`} sub={`Δ ${jibarFixings[2].change >= 0 ? "+" : ""}${jibarFixings[2].change.toFixed(2)}bp`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Index chart */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm font-medium flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" />JSE All Share — Intraday</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Source: IRIS /v1/indices/J203 · streaming</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold font-mono">{globalIndices[0].last.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}</p>
              <p className="text-xs text-success">+{globalIndices[0].change.toFixed(2)} ({formatPct(globalIndices[0].changePct)})</p>
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={intraday}>
                <defs>
                  <linearGradient id="grad1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(227, 71%, 55%)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(227, 71%, 55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} stroke="hsl(220, 9%, 46%)" interval={11} />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(220, 9%, 46%)" domain={['dataMin - 50', 'dataMax + 50']} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <ReferenceLine y={intraday[0].v} stroke="hsl(220, 9%, 46%)" strokeDasharray="4 4" label={{ value: "Prev close", fontSize: 10, fill: "hsl(220, 9%, 46%)", position: "insideTopLeft" }} />
                <Area type="monotone" dataKey="v" stroke="hsl(227, 71%, 55%)" strokeWidth={2} fill="url(#grad1)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* News */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2"><Newspaper className="h-4 w-4 text-primary" />News Flow</CardTitle>
            <p className="text-xs text-muted-foreground">IRIS /v1/news · Reuters · SENS · Bloomberg</p>
          </CardHeader>
          <CardContent className="p-0 max-h-[256px] overflow-y-auto">
            <div className="divide-y divide-border">
              {newsFeed.slice(0, 8).map(n => (
                <div key={n.id} className="px-4 py-2.5 hover:bg-secondary/50">
                  <div className="flex items-start gap-2">
                    {n.priority === "high" && <span className="h-1.5 w-1.5 rounded-full bg-destructive mt-1.5 shrink-0" />}
                    <p className="text-xs font-medium leading-snug">{n.headline}</p>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                    <span>{n.time}</span><span>·</span><span>{n.source}</span>
                    {n.tickers.length > 0 && <><span>·</span><span className="text-primary">{n.tickers.join(" ")}</span></>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Strategies list */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Active Mandates</CardTitle>
            <p className="text-xs text-muted-foreground">Rebalance gated on investor count · pre-trade compliance via IRIS flags</p>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">{oemsStrategies.length} TOTAL</Badge>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Strategy</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium text-right">AUM</th>
                  <th className="px-3 py-2 font-medium text-right">Investors</th>
                  <th className="px-3 py-2 font-medium text-right">YTD</th>
                  <th className="px-3 py-2 font-medium text-right">Day P&L</th>
                  <th className="px-3 py-2 font-medium text-right">Sharpe</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {oemsStrategies.map(s => {
                  const reb = canRebalance(s);
                  return (
                    <tr key={s.id} className="hover:bg-secondary/30">
                      <td className="px-4 py-2.5">
                        <p className="font-medium">{s.name}</p>
                        <p className="text-[10px] text-muted-foreground">{s.manager} · bench {s.benchmark}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="outline" className={cn("text-[10px] font-mono", s.kind === "equity" ? "border-primary/40 text-primary" : "border-warning/40 text-warning")}>
                          {s.kind === "equity" ? "EQ" : "MM"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.aum > 0 ? formatZAR(s.aum) : "—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.investorCount}</td>
                      <td className={cn("px-3 py-2.5 text-right font-mono", s.ytd >= 0 ? "text-success" : "text-destructive")}>{formatPct(s.ytd)}</td>
                      <td className={cn("px-3 py-2.5 text-right font-mono", s.dayPnl >= 0 ? "text-success" : "text-destructive")}>{s.dayPnl !== 0 ? formatZAR(s.dayPnl) : "—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.sharpe.toFixed(2)}</td>
                      <td className="px-3 py-2.5">
                        <Badge variant="secondary" className={cn("text-[10px]",
                          s.status === "live" && "bg-success/10 text-success",
                          s.status === "paper" && "bg-muted text-muted-foreground",
                          s.status === "halted" && "bg-destructive/10 text-destructive")}>{s.status}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button size="sm" variant={reb ? "default" : "outline"} disabled={!reb} className="h-7 text-[10px]">
                          {reb ? "Rebalance" : <><Lock className="h-3 w-3 mr-1" />Locked</>}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Macro + Yield curve */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Globe2 className="h-4 w-4 text-primary" />Macro Pulse</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/macro/series · push on release</p></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {macroIndicators.map(m => (
              <div key={m.name} className="border border-border rounded-md p-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{m.name}</p>
                <p className="text-base font-semibold font-mono mt-0.5">{m.value}<span className="text-xs text-muted-foreground ml-1">{m.unit}</span></p>
                <p className={cn("text-[10px] font-mono", m.trend === "up" ? "text-success" : m.trend === "down" ? "text-destructive" : "text-muted-foreground")}>
                  prior {m.prior} · {m.trend}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">ZAR Sovereign Yield Curve</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/yieldcurve/zar · refit every 15min</p></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
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
    </div>
  );
}

function KpiTile({ icon, label, value, sub, positive, warning }: { icon: React.ReactNode; label: string; value: string; sub?: string; positive?: boolean; warning?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground"><div className={cn("h-7 w-7 rounded-md flex items-center justify-center", warning ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary")}>{icon}</div><p className="text-[10px] uppercase tracking-wider">{label}</p></div>
        <p className="text-xl font-semibold font-mono mt-2">{value}</p>
        {sub && <p className={cn("text-[10px] font-mono mt-0.5", positive === true && "text-success", positive === false && "text-destructive", positive === undefined && "text-muted-foreground")}>{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function OEMSDashboard() {
  const [tab, setTab] = useState("unified");
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">OEMS<Badge variant="outline" className="font-mono text-[10px]">MINT v4.2</Badge></h1>
          <p className="text-sm text-muted-foreground mt-0.5">Order &amp; Execution Management · institutional desk · {new Date().toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} {new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })} SAST</p>
        </div>
        <Badge className="bg-success/10 text-success border-success/30 font-mono text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-success mr-1.5 inline-block animate-pulse" />MARKET OPEN</Badge>
      </div>

      <Ticker />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-secondary">
          <TabsTrigger value="unified">Unified</TabsTrigger>
          <TabsTrigger value="equities">Equities</TabsTrigger>
          <TabsTrigger value="money_market">Money Market</TabsTrigger>
          <TabsTrigger value="market">Market Watch</TabsTrigger>
          <TabsTrigger value="macro">Macro</TabsTrigger>
          <TabsTrigger value="news">News</TabsTrigger>
          <TabsTrigger value="integration">IRIS Integration</TabsTrigger>
        </TabsList>
        <TabsContent value="unified" className="mt-4"><Unified /></TabsContent>
        <TabsContent value="equities" className="mt-4"><OEMSEquities /></TabsContent>
        <TabsContent value="money_market" className="mt-4"><OEMSMoneyMarket /></TabsContent>
        <TabsContent value="market" className="mt-4"><OEMSMarket /></TabsContent>
        <TabsContent value="macro" className="mt-4"><OEMSMacro /></TabsContent>
        <TabsContent value="news" className="mt-4"><OEMSNews /></TabsContent>
        <TabsContent value="integration" className="mt-4"><OEMSIntegration /></TabsContent>
      </Tabs>
    </div>
  );
}
