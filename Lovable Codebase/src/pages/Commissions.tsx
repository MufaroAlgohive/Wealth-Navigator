import { clients, strategies, formatCurrency, formatPct } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import StatCard from "@/components/StatCard";
import { DollarSign, TrendingUp, Users, Percent } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const activeClients = clients.filter((c) => c.status === "active");
const totalAUM = activeClients.reduce((s, c) => s + c.aum, 0);
const aumFee = totalAUM * 0.001; // 0.1% recurring

const perfFees = strategies.map((st) => {
  const perfFee = st.aum * Math.max(0, st.ytdReturn / 100) * 0.20;
  const wmShare = perfFee * 0.13;
  return { name: st.name, perfFee, wmShare, ytdReturn: st.ytdReturn };
});

const totalPerfFee = perfFees.reduce((s, f) => s + f.perfFee, 0);
const totalWmShare = perfFees.reduce((s, f) => s + f.wmShare, 0);
const totalComp = aumFee + totalWmShare;

const monthlyComp = Array.from({ length: 6 }, (_, i) => {
  const month = new Date(2025, 10 + i, 1);
  const aumPortion = aumFee / 12 * (0.9 + Math.random() * 0.2);
  const perfPortion = totalWmShare / 12 * (0.5 + Math.random());
  return {
    month: month.toLocaleDateString("en-ZA", { month: "short" }),
    aum: +aumPortion.toFixed(0),
    performance: +perfPortion.toFixed(0),
  };
});

const cumulativeData = monthlyComp.map((m, i) => ({
  ...m,
  cumulative: monthlyComp.slice(0, i + 1).reduce((s, x) => s + x.aum + x.performance, 0),
}));

export default function Commissions() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Commissions</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Your compensation breakdown and fee tracking</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Compensation" value={formatCurrency(totalComp)} subtitle="annualised" icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="AUM Fee Revenue" value={formatCurrency(aumFee)} change="0.1% on AUM" changeType="neutral" icon={<Percent className="h-4 w-4" />} />
        <StatCard label="Performance Share" value={formatCurrency(totalWmShare)} change="13% of perf fees" changeType="neutral" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Book Size" value={formatCurrency(totalAUM)} subtitle={`${activeClients.length} clients`} icon={<Users className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Monthly Compensation Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyComp}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="aum" stackId="a" fill="hsl(227, 71%, 55%)" radius={[0, 0, 0, 0]} name="AUM Fee" />
                <Bar dataKey="performance" stackId="a" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} name="Perf. Share" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Fee Structure</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-secondary/50 rounded-lg p-4">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">AUM Management Fee</p>
              <p className="text-lg font-semibold mt-1">0.10%</p>
              <p className="text-xs text-muted-foreground mt-1">Recurring monthly on total AUM</p>
            </div>
            <div className="bg-secondary/50 rounded-lg p-4">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Performance Fee Share</p>
              <p className="text-lg font-semibold mt-1">13%</p>
              <p className="text-xs text-muted-foreground mt-1">Of the 20% performance fee charged by Mint on strategy returns</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Performance Fee by Strategy</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Strategy</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">AUM</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">YTD Return</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Perf Fee (20%)</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Your Share (13%)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {perfFees.map((f) => (
                <tr key={f.name} className="hover:bg-secondary/50">
                  <td className="px-6 py-3 text-sm font-medium">{f.name}</td>
                  <td className="text-right px-6 py-3 text-sm">{formatCurrency(strategies.find(s => s.name === f.name)!.aum)}</td>
                  <td className="text-right px-6 py-3 text-sm">{formatPct(f.ytdReturn)}</td>
                  <td className="text-right px-6 py-3 text-sm">{formatCurrency(f.perfFee)}</td>
                  <td className="text-right px-6 py-3 text-sm font-medium text-primary">{formatCurrency(f.wmShare)}</td>
                </tr>
              ))}
              <tr className="bg-secondary/30 font-semibold">
                <td className="px-6 py-3 text-sm" colSpan={3}>Total</td>
                <td className="text-right px-6 py-3 text-sm">{formatCurrency(totalPerfFee)}</td>
                <td className="text-right px-6 py-3 text-sm text-primary">{formatCurrency(totalWmShare)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
