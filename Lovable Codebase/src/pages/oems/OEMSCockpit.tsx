import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LineChart, Line } from "recharts";
import PanelFrame from "@/components/oems/PanelFrame";
import PriceCell from "@/components/oems/PriceCell";
import Sparkline from "@/components/oems/Sparkline";
import SectorHeatmap from "@/components/oems/SectorHeatmap";
import SensFeed from "@/components/oems/SensFeed";
import {
  globalIndices, fxQuotes, commodityQuotes, jseTopMovers, jibarFixings,
  zarYieldCurve, oemsStrategies, macroIndicators, generateIntraday,
  formatZAR, formatPct, canRebalance,
} from "@/lib/oemsData";
import { orders } from "@/lib/oemsExtra";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Lock, AlertTriangle, Activity, Layers, Banknote, TrendingUp } from "lucide-react";
import { useMemo } from "react";

function KpiTile({ icon, label, value, sub, positive, warning }: any) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className={cn("h-6 w-6 rounded flex items-center justify-center",
          warning ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary")}>{icon}</div>
        <p className="text-[9px] uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-lg font-semibold font-mono mt-1.5 leading-none">{value}</p>
      {sub && <p className={cn("text-[10px] font-mono mt-1",
        positive === true && "text-success", positive === false && "text-destructive",
        positive === undefined && "text-muted-foreground")}>{sub}</p>}
    </div>
  );
}

export default function OEMSCockpit() {
  const intraday = useMemo(() => generateIntraday(87412, 78, 0.0008), []);
  const totalAum = oemsStrategies.reduce((s, x) => s + x.aum, 0);
  const livePnl = oemsStrategies.reduce((s, x) => s + x.dayPnl, 0);
  const liveStrats = oemsStrategies.filter(s => s.status === "live").length;
  const blocked = oemsStrategies.filter(s => !canRebalance(s)).length;
  const openOrders = orders.filter(o => o.state === "WORKING" || o.state === "PARTIAL");

  return (
    <div className="space-y-3">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
        <KpiTile icon={<Layers className="h-3.5 w-3.5" />} label="Platform AUM" value={formatZAR(totalAum)} sub={`${oemsStrategies.length} strats · ${liveStrats} live`} />
        <KpiTile icon={<Activity className="h-3.5 w-3.5" />} label="Day P&L" value={formatZAR(livePnl)} sub={formatPct((livePnl / totalAum) * 100, 3)} positive={livePnl >= 0} />
        <KpiTile icon={<Lock className="h-3.5 w-3.5" />} label="Reb. Locked" value={blocked.toString()} sub="no investors / halted" warning />
        <KpiTile icon={<AlertTriangle className="h-3.5 w-3.5" />} label="Open Orders" value={openOrders.length.toString()} sub={`${orders.filter(o => o.state === "REJECTED").length} rejected`} warning={openOrders.length > 0} />
        <KpiTile icon={<Banknote className="h-3.5 w-3.5" />} label="JIBAR 3M" value={`${jibarFixings[2].rate.toFixed(2)}%`} sub={`Δ ${jibarFixings[2].change >= 0 ? "+" : ""}${jibarFixings[2].change.toFixed(2)}bp`} />
        <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="USDZAR" value={<PriceCell tickKey="USDZAR" fallback={18.4520} decimals={4} showChange={false} />} sub={<PriceCell tickKey="USDZAR" fallback={18.4520} decimals={4} showChange />} />
      </div>

      {/* Row 1: heatmap | curve | movers */}
      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title="JSE Sector Heatmap" endpoint="GET /v1/indices/sectors" className="col-span-5 h-[280px]">
          <SectorHeatmap />
        </PanelFrame>

        <PanelFrame title="ZAR Sovereign Curve" endpoint="GET /v1/yieldcurve/zar?model=nss" className="col-span-4 h-[280px]"
          right={<span className="font-mono">10Y · {zarYieldCurve[8].yield.toFixed(2)}%</span>}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={zarYieldCurve} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis dataKey="tenor" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="%" domain={['dataMin - 0.3', 'dataMax + 0.3']} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} formatter={(v: number) => `${v.toFixed(2)}%`} />
              <Line type="monotone" dataKey="yield" stroke="hsl(38, 92%, 50%)" strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </PanelFrame>

        <PanelFrame title="Top Movers · JSE" endpoint="GET /v1/quotes/movers?exchange=JSE" className="col-span-3 h-[280px]" dense scroll>
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-border">
              {jseTopMovers.slice(0, 8).map(m => (
                <tr key={m.symbol} className="hover:bg-muted/30">
                  <td className="px-2 py-1.5">
                    <p className="font-mono font-medium">{m.symbol}</p>
                    <p className="text-[9px] text-muted-foreground truncate max-w-[60px]">{m.name}</p>
                  </td>
                  <td className="px-1 py-1.5 w-[60px]">
                    <Sparkline base={m.last} vol={0.005} height={24} color={m.changePct >= 0 ? "hsl(142,71%,45%)" : "hsl(0,84%,60%)"} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <PriceCell tickKey={m.symbol} fallback={m.last} decimals={2} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelFrame>
      </div>

      {/* Row 2: index chart | sens */}
      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title="JSE All Share — Intraday" endpoint="WS /v1/indices/J203/stream" className="col-span-8 h-[280px]"
          right={<span className="font-mono">{globalIndices[0].last.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} · <span className="text-success">+{globalIndices[0].changePct.toFixed(2)}%</span></span>}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={intraday} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="ag1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(227,71%,55%)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="hsl(227,71%,55%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis dataKey="t" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" interval={11} />
              <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" domain={['dataMin - 40', 'dataMax + 40']} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
              <ReferenceLine y={intraday[0].v} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="v" stroke="hsl(227,71%,55%)" strokeWidth={1.8} fill="url(#ag1)" />
            </AreaChart>
          </ResponsiveContainer>
        </PanelFrame>

        <PanelFrame title="SENS · Live" endpoint="WS /v1/news/sens/stream" className="col-span-4 h-[280px]" dense scroll>
          <SensFeed limit={6} />
        </PanelFrame>
      </div>

      {/* Row 3: open orders | macro */}
      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title={`Open Orders · ${openOrders.length}`} endpoint="GET /v1/orders?state=working,partial" className="col-span-8" dense scroll>
          <table className="w-full text-[11px]">
            <thead className="bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5">Time</th><th className="text-left px-2">Strategy</th>
                <th className="text-left px-2">Side</th><th className="text-left px-2">Sym</th>
                <th className="text-right px-2">Qty</th><th className="text-right px-2">Filled</th>
                <th className="text-right px-2">Limit</th><th className="text-right px-2">Last</th>
                <th className="text-right px-2">VWAP</th><th className="text-right px-2">Slip</th>
                <th className="text-left px-2">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {openOrders.map(o => (
                <tr key={o.id} className="hover:bg-muted/30">
                  <td className="px-2 py-1.5 text-muted-foreground">{o.time}</td>
                  <td className="px-2 truncate">{o.strategy}</td>
                  <td className={cn("px-2 font-semibold", o.side === "BUY" ? "text-success" : "text-destructive")}>{o.side}</td>
                  <td className="px-2 font-medium">{o.symbol}</td>
                  <td className="px-2 text-right">{o.qty.toLocaleString()}</td>
                  <td className="px-2 text-right">{o.filled.toLocaleString()} <span className="text-[9px] text-muted-foreground">({Math.round(o.filled / o.qty * 100)}%)</span></td>
                  <td className="px-2 text-right">{o.limit?.toFixed(2) ?? "MKT"}</td>
                  <td className="px-2 text-right"><PriceCell tickKey={o.symbol} fallback={o.last} decimals={2} showChange={false} /></td>
                  <td className="px-2 text-right">{o.vwap.toFixed(2)}</td>
                  <td className={cn("px-2 text-right", o.slippageBps >= 0 ? "text-success" : "text-destructive")}>{o.slippageBps.toFixed(1)}bp</td>
                  <td className="px-2"><Badge variant="outline" className="text-[9px] font-mono h-4">{o.state}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelFrame>

        <PanelFrame title="Macro Pulse" endpoint="GET /v1/macro/series" className="col-span-4">
          <div className="grid grid-cols-2 gap-2">
            {macroIndicators.slice(0, 8).map(m => (
              <div key={m.name} className="border border-border rounded p-2">
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider truncate">{m.name}</p>
                <p className="text-sm font-semibold font-mono mt-0.5">{m.value}<span className="text-[10px] text-muted-foreground ml-1">{m.unit}</span></p>
                <p className={cn("text-[9px] font-mono", m.trend === "up" ? "text-success" : m.trend === "down" ? "text-destructive" : "text-muted-foreground")}>prior {m.prior}</p>
              </div>
            ))}
          </div>
        </PanelFrame>
      </div>
    </div>
  );
}
