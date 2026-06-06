import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, ArrowDownRight, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";
import { globalIndices, fxQuotes, commodityQuotes, jseTopMovers, formatPct, generateIntraday } from "@/lib/oemsData";
import { AreaChart, Area, ResponsiveContainer } from "recharts";

export default function OEMSMarket() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Global Indices</CardTitle>
            <p className="text-xs text-muted-foreground">IRIS /v1/indices · 5s refresh</p>
          </div>
          <Badge className="bg-success/10 text-success border-success/30 font-mono text-[10px]"><Wifi className="h-3 w-3 mr-1" />STREAMING</Badge>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {globalIndices.map(idx => {
            const s = generateIntraday(idx.last, 30, 0.001);
            return (
              <div key={idx.code} className="border border-border rounded-md p-3 hover:bg-secondary/30 transition-colors">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <p className="text-xs font-medium">{idx.name}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">{idx.code} · {idx.region}</p>
                  </div>
                  <Badge variant="outline" className="text-[9px] font-mono">{idx.region}</Badge>
                </div>
                <p className="text-base font-semibold font-mono mt-2">{idx.last.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}</p>
                <p className={cn("text-[11px] font-mono flex items-center gap-0.5", idx.changePct >= 0 ? "text-success" : "text-destructive")}>
                  {idx.changePct >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {idx.change >= 0 ? "+" : ""}{idx.change.toFixed(2)} ({formatPct(idx.changePct)})
                </p>
                <ResponsiveContainer width="100%" height={40}>
                  <AreaChart data={s}>
                    <defs>
                      <linearGradient id={`g-${idx.code}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={idx.changePct >= 0 ? "hsl(142, 71%, 45%)" : "hsl(0, 84%, 60%)"} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={idx.changePct >= 0 ? "hsl(142, 71%, 45%)" : "hsl(0, 84%, 60%)"} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="v" stroke={idx.changePct >= 0 ? "hsl(142, 71%, 45%)" : "hsl(0, 84%, 60%)"} strokeWidth={1.5} fill={`url(#g-${idx.code})`} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">FX</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/fx · 2s</p></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border">
                {fxQuotes.map(f => (
                  <tr key={f.pair} className="hover:bg-secondary/30 font-mono">
                    <td className="px-4 py-2.5 font-semibold">{f.pair}</td>
                    <td className="px-3 py-2.5 text-right">{f.last.toFixed(4)}</td>
                    <td className={cn("px-3 py-2.5 text-right text-[11px]", f.changePct >= 0 ? "text-success" : "text-destructive")}>
                      {f.change >= 0 ? "+" : ""}{f.change.toFixed(4)} ({formatPct(f.changePct)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Commodities</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/commodities · CME/ICE feeds</p></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border">
                {commodityQuotes.map(c => (
                  <tr key={c.name} className="hover:bg-secondary/30 font-mono">
                    <td className="px-4 py-2.5 font-sans font-medium">{c.name}</td>
                    <td className="px-3 py-2.5 text-right">{c.last.toFixed(2)}</td>
                    <td className={cn("px-3 py-2.5 text-right text-[11px]", c.changePct >= 0 ? "text-success" : "text-destructive")}>
                      {c.change >= 0 ? "+" : ""}{c.change.toFixed(2)} ({formatPct(c.changePct)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">JSE Movers — Top 10</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/securities/quotes?exchange=JSE</p></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Sym</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">ISIN</th>
                  <th className="px-3 py-2 font-medium text-right">Last</th>
                  <th className="px-3 py-2 font-medium text-right">Bid</th>
                  <th className="px-3 py-2 font-medium text-right">Ask</th>
                  <th className="px-3 py-2 font-medium text-right">VWAP</th>
                  <th className="px-3 py-2 font-medium text-right">Vol</th>
                  <th className="px-3 py-2 font-medium text-right">MCap</th>
                  <th className="px-3 py-2 font-medium text-right">Chg %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jseTopMovers.map(i => (
                  <tr key={i.symbol} className="hover:bg-secondary/30 font-mono">
                    <td className="px-4 py-2 font-semibold">{i.symbol}</td>
                    <td className="px-3 py-2 font-sans">{i.name}</td>
                    <td className="px-3 py-2 text-muted-foreground text-[10px]">{i.isin}</td>
                    <td className="px-3 py-2 text-right">{i.last.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{i.bid.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{i.ask.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">{i.vwap.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{(i.volume / 1000).toFixed(0)}k</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{i.marketCap ? `R${(i.marketCap / 1e9).toFixed(0)}bn` : "—"}</td>
                    <td className={cn("px-3 py-2 text-right", i.changePct >= 0 ? "text-success" : "text-destructive")}>{formatPct(i.changePct)}</td>
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
