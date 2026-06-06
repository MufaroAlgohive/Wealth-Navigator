import { fcPayments, fcGroups, fcMembers, formatCurrency, statusColors } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import StatCard from "@/components/StatCard";
import { DollarSign, TrendingUp, AlertTriangle, Users, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const aprilPayments = fcPayments.filter(p => p.month === "2026-04");
const totalDue = aprilPayments.reduce((s, p) => s + p.premiumDue, 0);
const totalCollected = aprilPayments.reduce((s, p) => s + p.amountCollected, 0);
const totalArrears = aprilPayments.reduce((s, p) => s + p.arrears, 0);
const avgSuccess = aprilPayments.length ? aprilPayments.reduce((s, p) => s + p.successRate, 0) / aprilPayments.length : 0;
const totalOutstanding = aprilPayments.reduce((s, p) => s + p.membersOutstanding, 0);

const monthlyData = [
  { month: "Jan", collected: 365000, due: 375000 },
  { month: "Feb", collected: 372000, due: 382000 },
  { month: "Mar", collected: 371000, due: 395000 },
  { month: "Apr", collected: totalCollected, due: totalDue },
];

const unpaidMembers = fcMembers.filter(m => m.arrears > 0 || m.status === "unpaid");

export default function FCPayments() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments & Collections</h1>
        <p className="text-sm text-muted-foreground mt-0.5">April 2026 collection cycle</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Premium Due" value={formatCurrency(totalDue)} icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Collected" value={formatCurrency(totalCollected)} change={`${((totalCollected / totalDue) * 100).toFixed(1)}%`} changeType="positive" icon={<CheckCircle className="h-4 w-4" />} />
        <StatCard label="Arrears" value={formatCurrency(totalArrears)} changeType="negative" icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard label="Success Rate" value={`${avgSuccess.toFixed(1)}%`} icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Outstanding" value={`${totalOutstanding} members`} icon={<Users className="h-4 w-4" />} />
      </div>

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Monthly Collections</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,13%,91%)" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => [`R${v.toLocaleString()}`, ""]} />
              <Bar dataKey="due" fill="hsl(220,14%,96%)" radius={[4, 4, 0, 0]} name="Due" />
              <Bar dataKey="collected" fill="hsl(142,71%,45%)" radius={[4, 4, 0, 0]} name="Collected" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Tabs defaultValue="bygroup">
        <TabsList>
          <TabsTrigger value="bygroup">By Group</TabsTrigger>
          <TabsTrigger value="outstanding">Outstanding Members ({unpaidMembers.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="bygroup">
          <Card>
            <CardContent className="p-0">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Group</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Method</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Due</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Collected</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Arrears</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Rate</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Outstanding</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Recovered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {aprilPayments.map(p => {
                    const group = fcGroups.find(g => g.id === p.groupId);
                    return (
                      <tr key={p.id} className="hover:bg-secondary/50">
                        <td className="px-5 py-3 text-sm font-medium">{group?.name}</td>
                        <td className="px-5 py-3 text-center"><Badge variant="outline" className="text-[10px]">{p.method.replace("_", " ")}</Badge></td>
                        <td className="px-5 py-3 text-sm text-right">{formatCurrency(p.premiumDue)}</td>
                        <td className="px-5 py-3 text-sm text-right text-success font-medium">{formatCurrency(p.amountCollected)}</td>
                        <td className="px-5 py-3 text-sm text-right">{p.arrears > 0 ? <span className="text-destructive">{formatCurrency(p.arrears)}</span> : "—"}</td>
                        <td className="px-5 py-3 text-center">
                          <Badge variant="secondary" className={cn("text-[10px]", p.successRate >= 95 ? "bg-success/10 text-success" : p.successRate >= 85 ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")}>{p.successRate}%</Badge>
                        </td>
                        <td className="px-5 py-3 text-sm text-center">{p.membersOutstanding}</td>
                        <td className="px-5 py-3 text-sm text-center text-success">{p.membersRecovered}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="outstanding">
          <Card>
            <CardContent className="p-0">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Member</th>
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Group</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Premium</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Arrears</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Status</th>
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Last Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {unpaidMembers.map(m => {
                    const group = fcGroups.find(g => g.id === m.groupId);
                    return (
                      <tr key={m.id} className="hover:bg-secondary/50">
                        <td className="px-5 py-3"><p className="text-sm font-medium">{m.name}</p><p className="text-xs text-muted-foreground">{m.idNumber}</p></td>
                        <td className="px-5 py-3 text-sm text-muted-foreground">{group?.name}</td>
                        <td className="px-5 py-3 text-sm text-right">R{m.premium}/pm</td>
                        <td className="px-5 py-3 text-sm text-right text-destructive font-medium">R{m.arrears}</td>
                        <td className="px-5 py-3 text-center"><Badge variant="secondary" className={cn("text-[10px]", statusColors[m.status])}>{m.status.replace("_", " ")}</Badge></td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">{m.lastPaymentDate || "Never"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
