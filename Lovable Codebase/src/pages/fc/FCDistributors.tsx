import { fcDistributors, formatCurrency } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import StatCard from "@/components/StatCard";
import { Users, DollarSign, TrendingUp, UserMinus, FileText, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LineChart, Line } from "recharts";

const totalOnboarded = fcDistributors.reduce((s, d) => s + d.membersOnboarded, 0);
const totalBook = fcDistributors.reduce((s, d) => s + d.activePremiumBook, 0);
const totalCommissions = fcDistributors.reduce((s, d) => s + d.commissionsEarned, 0);
const totalLapsed = fcDistributors.reduce((s, d) => s + d.lapsedMembers, 0);

export default function FCDistributors() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Distributor Performance</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Partner and field distributor sales operations</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Members Onboarded" value={totalOnboarded.toString()} icon={<Users className="h-4 w-4" />} />
        <StatCard label="Active Premium Book" value={formatCurrency(totalBook)} subtitle="monthly" icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Commissions Earned" value={formatCurrency(totalCommissions)} changeType="positive" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Lapsed Members" value={totalLapsed.toString()} changeType="negative" icon={<UserMinus className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {fcDistributors.map(dist => {
          const retentionRate = dist.membersOnboarded > 0 ? ((dist.retainedMembers / dist.membersOnboarded) * 100).toFixed(1) : "0";
          return (
            <Card key={dist.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center",
                      dist.type === "parlour" ? "bg-destructive/10 text-destructive" :
                      dist.type === "broker" ? "bg-primary/10 text-primary" :
                      "bg-warning/10 text-warning"
                    )}>
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-sm font-semibold">{dist.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">{dist.type}</Badge>
                        <span className="text-[10px] text-muted-foreground">{dist.region}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-secondary/50 rounded-lg p-3 text-center">
                    <p className="text-[10px] text-muted-foreground uppercase">Onboarded</p>
                    <p className="text-lg font-bold">{dist.membersOnboarded}</p>
                  </div>
                  <div className="bg-secondary/50 rounded-lg p-3 text-center">
                    <p className="text-[10px] text-muted-foreground uppercase">Retained</p>
                    <p className="text-lg font-bold">{dist.retainedMembers}</p>
                    <p className="text-[10px] text-success">{retentionRate}%</p>
                  </div>
                  <div className="bg-secondary/50 rounded-lg p-3 text-center">
                    <p className="text-[10px] text-muted-foreground uppercase">Premium Book</p>
                    <p className="text-sm font-bold">{formatCurrency(dist.activePremiumBook)}/pm</p>
                  </div>
                  <div className="bg-success/5 rounded-lg p-3 text-center border border-success/20">
                    <p className="text-[10px] text-muted-foreground uppercase">Commissions</p>
                    <p className="text-sm font-bold text-success">{formatCurrency(dist.commissionsEarned)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{dist.lapsedMembers} lapsed</span>
                  <span>{dist.pendingApplications} pending</span>
                </div>

                {/* Trend */}
                <ResponsiveContainer width="100%" height={100}>
                  <LineChart data={dist.monthlyTrend}>
                    <XAxis dataKey="month" tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(v: number, name: string) => [name === "members" ? v : `R${v.toLocaleString()}`, name]} />
                    <Line type="monotone" dataKey="members" stroke="hsl(227,71%,55%)" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="commission" stroke="hsl(142,71%,45%)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
