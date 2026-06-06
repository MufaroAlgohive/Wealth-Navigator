import { TrendingUp, Users, DollarSign, Briefcase, ArrowUpRight, ArrowDownRight, BarChart3 } from "lucide-react";
import StatCard from "@/components/StatCard";
import { strategies, strategists, formatCurrency, formatPct, calcPerfFee, calcStrategistBonus } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";

// Current strategist: Andile Khumalo (st1)
const CURRENT_STRATEGIST_ID = "st1";
const currentStrategist = strategists.find((s) => s.id === CURRENT_STRATEGIST_ID)!;

const myStrategies = strategies.filter((s) => s.managerIds.includes(CURRENT_STRATEGIST_ID));
const totalAUM = myStrategies.reduce((s, st) => s + st.aum, 0);
const totalInvestors = myStrategies.reduce((s, st) => s + st.investorCount, 0);
const totalProfit = myStrategies.reduce((s, st) => s + st.aum * Math.max(0, st.ytdReturn / 100), 0);
const totalFees = myStrategies.reduce((s, st) => s + calcPerfFee(st), 0);
const totalBonus = myStrategies.reduce((s, st) => s + calcStrategistBonus(st, CURRENT_STRATEGIST_ID), 0);

const aumGrowth = Array.from({ length: 12 }, (_, i) => {
  const month = new Date(2025, 7 + i, 1);
  const base = totalAUM * (0.85 + i * 0.015);
  return {
    date: month.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" }),
    aum: +(base / 1e6).toFixed(1),
    bonus: +((totalBonus / 12) * (0.7 + i * 0.03) / 1e3).toFixed(0),
  };
});

export default function StrategistDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Strategist Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {currentStrategist.name} · {myStrategies.length} {myStrategies.length === 1 ? "strategy" : "strategies"} · {new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Total AUM" value={formatCurrency(totalAUM)} change="+4.1% MTD" changeType="positive" icon={<Briefcase className="h-4 w-4" />} />
        <StatCard label="Total Investors" value={totalInvestors.toString()} icon={<Users className="h-4 w-4" />} />
        <StatCard label="Profit Generated" value={formatCurrency(totalProfit)} subtitle="YTD" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Fees Generated" value={formatCurrency(totalFees)} subtitle="20% of profit" icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="My Bonus" value={formatCurrency(totalBonus)} change="13% share" changeType="positive" icon={<BarChart3 className="h-4 w-4" />} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">AUM Growth (R millions)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={aumGrowth}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="aum" stroke="hsl(227, 71%, 55%)" strokeWidth={2} dot={false} name="AUM (Rm)" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Monthly Bonus (R thousands)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={aumGrowth}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="bonus" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} name="Bonus (Rk)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Performance */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">My Strategies — Performance & Fee Economics</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Strategy</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">AUM</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">YTD Return</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Investors</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Max DD</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Profit</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Perf Fee (20%)</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">My Bonus</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {myStrategies.map((st) => {
                const profit = st.aum * Math.max(0, st.ytdReturn / 100);
                const perfFee = calcPerfFee(st);
                const bonus = calcStrategistBonus(st, CURRENT_STRATEGIST_ID);
                const splitNote = st.managerIds.length > 1 ? ` (1/${st.managerIds.length} split)` : "";
                return (
                  <tr key={st.id} className="hover:bg-secondary/50">
                    <td className="px-6 py-3">
                      <p className="text-sm font-medium">{st.name}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">{st.type}</Badge>
                        {st.managerIds.length > 1 && <Badge variant="secondary" className="text-[10px]">Shared</Badge>}
                      </div>
                    </td>
                    <td className="text-right px-6 py-3 text-sm">{formatCurrency(st.aum)}</td>
                    <td className="text-right px-6 py-3">
                      <span className={cn("text-sm font-medium flex items-center justify-end gap-1", st.ytdReturn >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                        {st.ytdReturn >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {formatPct(st.ytdReturn)}
                      </span>
                    </td>
                    <td className="text-right px-6 py-3 text-sm">{st.investorCount}</td>
                    <td className="text-right px-6 py-3 text-sm text-ticker-negative">{formatPct(st.maxDrawdown)}</td>
                    <td className="text-right px-6 py-3 text-sm">{formatCurrency(profit)}</td>
                    <td className="text-right px-6 py-3 text-sm">{formatCurrency(perfFee)}</td>
                    <td className="text-right px-6 py-3 text-sm font-medium text-primary">
                      {formatCurrency(bonus)}
                      <span className="text-[10px] text-muted-foreground block">{splitNote}</span>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-secondary/30 font-semibold">
                <td className="px-6 py-3 text-sm" colSpan={5}>Total</td>
                <td className="text-right px-6 py-3 text-sm">{formatCurrency(totalProfit)}</td>
                <td className="text-right px-6 py-3 text-sm">{formatCurrency(totalFees)}</td>
                <td className="text-right px-6 py-3 text-sm text-primary">{formatCurrency(totalBonus)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
