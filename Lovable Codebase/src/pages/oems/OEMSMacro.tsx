import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { macroCalendar, macroIndicators, zarYieldCurve } from "@/lib/oemsData";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from "recharts";

export default function OEMSMacro() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {macroIndicators.map(m => (
          <Card key={m.name}>
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider truncate">{m.name}</p>
              <p className="text-lg font-semibold font-mono mt-1">{m.value}<span className="text-[10px] text-muted-foreground ml-0.5">{m.unit}</span></p>
              <p className={cn("text-[10px] font-mono", m.trend === "up" ? "text-success" : m.trend === "down" ? "text-destructive" : "text-muted-foreground")}>
                {m.trend === "up" ? "▲" : m.trend === "down" ? "▼" : "—"} prior {m.prior}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><CalendarDays className="h-4 w-4 text-primary" />Upcoming Releases</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/macro/calendar · ZA + US</p></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">CC</th>
                  <th className="px-3 py-2 font-medium">Indicator</th>
                  <th className="px-3 py-2 font-medium text-right">Forecast</th>
                  <th className="px-3 py-2 font-medium text-right">Prior</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {macroCalendar.map(r => (
                  <tr key={r.id} className={cn("hover:bg-secondary/30", r.importance === "high" && "bg-destructive/[0.03]")}>
                    <td className="px-4 py-2 font-mono">{r.date.slice(5)}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{r.time}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="text-[10px] font-mono">{r.country}</Badge></td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        {r.importance === "high" && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
                        {r.indicator} <span className="text-muted-foreground text-[10px]">({r.period})</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{r.forecast}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{r.previous}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" />ZAR Yield Curve</CardTitle><p className="text-xs text-muted-foreground">IRIS /v1/yieldcurve/zar · NSS fit</p></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
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

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Indicator Surprise (Actual vs Consensus, last 12m)</CardTitle><p className="text-xs text-muted-foreground">Higher bar = bigger upside surprise · IRIS macro series</p></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={[
              { name: "CPI", v: -0.1 }, { name: "GDP", v: 0.3 }, { name: "PMI", v: 0.6 }, { name: "Retail", v: -0.4 },
              { name: "PPI", v: 0.2 }, { name: "Mining", v: 1.2 }, { name: "Manufact.", v: -0.8 }, { name: "Curr Acct", v: 0.4 },
            ]}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(220, 9%, 46%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(220, 9%, 46%)" />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="v" radius={[4, 4, 0, 0]}>
                {[-0.1, 0.3, 0.6, -0.4, 0.2, 1.2, -0.8, 0.4].map((v, i) => (
                  <Cell key={i} fill={v >= 0 ? "hsl(142, 71%, 45%)" : "hsl(0, 84%, 60%)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
