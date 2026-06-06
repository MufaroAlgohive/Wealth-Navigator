import { useState } from "react";
import { ArrowUpRight, ArrowDownRight, Users as UsersIcon, BarChart3, TrendingUp } from "lucide-react";
import { strategies, formatCurrency, formatPct, getStrategistNames, calcPerfFee } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const CURRENT_STRATEGIST_ID = "st1";
const myStrategies = strategies.filter((s) => s.managerIds.includes(CURRENT_STRATEGIST_ID));

export default function StrategistStrategies() {
  const [selected, setSelected] = useState(myStrategies[0]?.id ?? "");
  const strategy = myStrategies.find((s) => s.id === selected);

  const perfData = Array.from({ length: 12 }, (_, i) => ({
    month: new Date(2025, 7 + i, 1).toLocaleDateString("en-ZA", { month: "short" }),
    value: +(100 + (strategy?.ytdReturn ?? 0) * (i / 11) + (Math.random() - 0.5) * 2).toFixed(2),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Strategies</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Detailed performance and risk metrics</p>
      </div>

      {/* Strategy Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {myStrategies.map((st) => (
          <Card
            key={st.id}
            className={cn("cursor-pointer transition-all", selected === st.id ? "ring-2 ring-primary shadow-md" : "hover:shadow-sm")}
            onClick={() => setSelected(st.id)}
          >
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-base font-semibold">{st.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{st.investorCount} investors · {st.instruments} instruments</p>
                </div>
                <Badge variant="outline" className="text-[10px]">{st.type}</Badge>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-4">
                <div className="text-center bg-secondary/50 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground uppercase">YTD</p>
                  <p className={cn("text-sm font-semibold", st.ytdReturn >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                    {formatPct(st.ytdReturn)}
                  </p>
                </div>
                <div className="text-center bg-secondary/50 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground uppercase">Sharpe</p>
                  <p className="text-sm font-semibold">{st.sharpeRatio.toFixed(2)}</p>
                </div>
                <div className="text-center bg-secondary/50 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground uppercase">AUM</p>
                  <p className="text-sm font-semibold">{formatCurrency(st.aum)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Detail for selected strategy */}
      {strategy && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{strategy.name} — Performance</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={perfData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" domain={['dataMin - 1', 'dataMax + 1']} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Line type="monotone" dataKey="value" stroke="hsl(227, 71%, 55%)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Risk & Fee Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { label: "Max Drawdown", value: formatPct(strategy.maxDrawdown), color: "text-ticker-negative" },
                { label: "Volatility", value: `${strategy.volatility.toFixed(1)}%`, color: "" },
                { label: "Sharpe Ratio", value: strategy.sharpeRatio.toFixed(2), color: "" },
                { label: "AUM", value: formatCurrency(strategy.aum), color: "" },
                { label: "20% Perf Fee", value: formatCurrency(calcPerfFee(strategy)), color: "" },
              ].map((m) => (
                <div key={m.label} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                  <span className="text-xs text-muted-foreground">{m.label}</span>
                  <span className={cn("text-sm font-semibold", m.color)}>{m.value}</span>
                </div>
              ))}
              <div className="bg-secondary/50 rounded-lg p-3 mt-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Sector Exposure</p>
                <div className="mt-2 space-y-1.5">
                  {strategy.sectorExposure.map((sec) => (
                    <div key={sec.sector} className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${sec.weight}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground w-20 text-right">{sec.sector}</span>
                      <span className="text-[10px] font-medium w-8 text-right">{sec.weight}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
