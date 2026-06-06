import { useState } from "react";
import PanelFrame from "@/components/oems/PanelFrame";
import PriceCell from "@/components/oems/PriceCell";
import DepthLadder from "@/components/oems/DepthLadder";
import TimeAndSales from "@/components/oems/TimeAndSales";
import Sparkline from "@/components/oems/Sparkline";
import { jseTopMovers, generateIntraday } from "@/lib/oemsData";
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export default function OEMSSecurity() {
  const [sym, setSym] = useState("NPN");
  const inst = jseTopMovers.find(i => i.symbol === sym) ?? jseTopMovers[0];
  const intraday = generateIntraday(inst.last, 78, 0.0012);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Security Lookup · {inst.symbol}</h1>
          <p className="text-xs text-muted-foreground">{inst.name} · {inst.exchange} · {inst.isin} · {inst.sector}</p>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={sym} onChange={e => setSym(e.target.value.toUpperCase())} placeholder="Ticker / ISIN / RIC" className="h-8 pl-7 text-xs" />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        {/* watchlist */}
        <PanelFrame title="Watchlist · JSE" endpoint="GET /v1/quotes/batch" className="col-span-2 h-[420px]" dense scroll>
          <div className="divide-y divide-border">
            {jseTopMovers.map(m => (
              <button key={m.symbol} onClick={() => setSym(m.symbol)}
                className={cn("w-full text-left px-2 py-1.5 hover:bg-muted/40 text-[11px]", sym === m.symbol && "bg-primary/10")}>
                <div className="flex items-center justify-between">
                  <span className="font-mono font-medium">{m.symbol}</span>
                  <PriceCell tickKey={m.symbol} fallback={m.last} decimals={2} showChange={false} />
                </div>
                <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                  <span className="truncate max-w-[80px]">{m.name}</span>
                  <span className={m.changePct >= 0 ? "text-success" : "text-destructive"}>{m.changePct >= 0 ? "+" : ""}{m.changePct.toFixed(2)}%</span>
                </div>
              </button>
            ))}
          </div>
        </PanelFrame>

        {/* main chart */}
        <PanelFrame title={`${inst.symbol} · Intraday`} endpoint={`WS /v1/quotes/${inst.isin}/stream`} className="col-span-6 h-[420px]"
          right={<span className="font-mono"><PriceCell tickKey={inst.symbol} fallback={inst.last} decimals={2} /></span>}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={intraday} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="ag2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(227,71%,55%)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="hsl(227,71%,55%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis dataKey="t" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" interval={11} />
              <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" domain={['dataMin - 1', 'dataMax + 1']} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
              <Area type="monotone" dataKey="v" stroke="hsl(227,71%,55%)" strokeWidth={1.8} fill="url(#ag2)" />
            </AreaChart>
          </ResponsiveContainer>
        </PanelFrame>

        {/* depth + tape */}
        <PanelFrame title="Depth · L2" endpoint={`WS /v1/depth/${inst.isin}/stream`} className="col-span-2 h-[420px]" dense scroll>
          <DepthLadder mid={inst.last} tick={inst.last > 1000 ? 0.5 : 0.05} levels={8} />
        </PanelFrame>

        <PanelFrame title="Time & Sales" endpoint={`WS /v1/trades/${inst.isin}/stream`} className="col-span-2 h-[420px]" dense scroll>
          <TimeAndSales mid={inst.last} n={28} />
        </PanelFrame>
      </div>

      <div className="grid grid-cols-6 gap-2">
        {[
          ["P/E", "18.4"], ["EV/EBITDA", "11.2"], ["Div Yield", "2.4%"],
          ["Mkt Cap", "R1.81tn"], ["52w Hi", (inst.last * 1.18).toFixed(2)], ["52w Lo", (inst.last * 0.78).toFixed(2)],
          ["ADV (3m)", "1.8m"], ["Beta", "1.12"], ["VWAP", inst.vwap.toFixed(2)],
          ["Bid", inst.bid.toFixed(2)], ["Ask", inst.ask.toFixed(2)], ["Spread bp", (((inst.ask - inst.bid) / inst.last) * 10000).toFixed(1)],
        ].map(([l, v]) => (
          <div key={l as string} className="rounded border border-border bg-card p-2">
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{l}</p>
            <p className="text-sm font-mono font-semibold mt-0.5">{v}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
