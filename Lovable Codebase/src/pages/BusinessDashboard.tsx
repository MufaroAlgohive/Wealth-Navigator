import { Users, Shield, TrendingUp, DollarSign, Briefcase, Building2, Landmark, ArrowUpRight, ArrowDownRight } from "lucide-react";
import StatCard from "@/components/StatCard";
import { strategies, formatCurrency, formatPct } from "@/lib/mockData";
import { members, insuranceProducts, businessEntities, getActiveMembers, calcInsuranceMargin } from "@/lib/businessMockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";

const activeMembers = getActiveMembers();
const totalInvested = activeMembers.reduce((s, m) => s + m.totalInvested, 0);
const totalCurrentValue = activeMembers.reduce((s, m) => s + m.currentValue, 0);
const totalReturn = totalCurrentValue - totalInvested;
const returnPct = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0;

// Insurance revenue (200% markup = margin is 2x base)
const enrolledInsProducts = insuranceProducts.filter(p => p.status === "available");
const insuredMembers = activeMembers.filter(m => m.insuranceProducts.length > 0);
const monthlyInsuranceRevenue = insuredMembers.reduce((sum, m) => {
  return sum + m.insuranceProducts.reduce((ps, pid) => {
    const product = insuranceProducts.find(p => p.id === pid);
    return ps + (product ? calcInsuranceMargin(product) : 0);
  }, 0);
}, 0);

const totalMonthlyContributions = businessEntities.reduce((s, b) => s + b.monthlyContribution, 0);

// Charts
const contributionTrend = Array.from({ length: 8 }, (_, i) => {
  const month = new Date(2025, 8 + i, 1);
  return {
    date: month.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" }),
    contributions: +(totalMonthlyContributions * (0.7 + i * 0.04) + Math.random() * 5000).toFixed(0),
    insurance: +(monthlyInsuranceRevenue * (0.5 + i * 0.07) + Math.random() * 1000).toFixed(0),
  };
});

const allocationByStrategy = strategies
  .filter(s => activeMembers.some(m => m.strategiesAllocated.includes(s.id)))
  .map(s => {
    const allocated = activeMembers.reduce((sum, m) => {
      if (m.strategiesAllocated.includes(s.id)) {
        return sum + m.currentValue / m.strategiesAllocated.length;
      }
      return sum;
    }, 0);
    return { name: s.name, value: Math.round(allocated) };
  });

const PIE_COLORS = [
  "hsl(227, 71%, 55%)", "hsl(142, 71%, 45%)", "hsl(38, 92%, 50%)",
  "hsl(262, 60%, 55%)", "hsl(0, 84%, 60%)", "hsl(190, 70%, 50%)",
];

const memberStatusData = [
  { name: "Active", value: members.filter(m => m.status === "active").length, color: "hsl(142, 71%, 45%)" },
  { name: "Pending KYC", value: members.filter(m => m.status === "pending_kyc").length, color: "hsl(38, 92%, 50%)" },
  { name: "Onboarding", value: members.filter(m => m.status === "onboarding").length, color: "hsl(227, 71%, 55%)" },
];

export default function BusinessDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Business Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Employers & stokvels overview · {new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total AUM"
          value={formatCurrency(totalCurrentValue)}
          change={`${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(1)}% return`}
          changeType={returnPct >= 0 ? "positive" : "negative"}
          icon={<Briefcase className="h-4 w-4" />}
        />
        <StatCard
          label="Total Members"
          value={members.length.toString()}
          subtitle={`${activeMembers.length} active · ${members.filter(m => m.status === "pending_kyc").length} pending`}
          icon={<Users className="h-4 w-4" />}
        />
        <StatCard
          label="Monthly Contributions"
          value={formatCurrency(totalMonthlyContributions)}
          change="+4.2% MoM"
          changeType="positive"
          icon={<DollarSign className="h-4 w-4" />}
        />
        <StatCard
          label="Insurance Revenue"
          value={`R${monthlyInsuranceRevenue.toLocaleString()}/mo`}
          subtitle={`${insuredMembers.length} insured members`}
          icon={<Shield className="h-4 w-4" />}
        />
      </div>

      {/* Entities */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {businessEntities.map((entity) => (
          <Card key={entity.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-10 w-10 rounded-lg flex items-center justify-center",
                    entity.type === "employer" ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning"
                  )}>
                    {entity.type === "employer" ? <Building2 className="h-5 w-5" /> : <Landmark className="h-5 w-5" />}
                  </div>
                  <div>
                    <CardTitle className="text-sm font-semibold">{entity.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{entity.registrationNumber} · {entity.contactPerson}</p>
                  </div>
                </div>
                <Badge variant="secondary" className={cn("text-[10px]",
                  entity.status === "active" && "bg-success/10 text-success"
                )}>
                  {entity.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-secondary/50 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">AUM</p>
                  <p className="text-sm font-semibold mt-1">{formatCurrency(entity.totalAUM)}</p>
                </div>
                <div className="bg-secondary/50 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Members</p>
                  <p className="text-sm font-semibold mt-1">{entity.activeMembers}/{entity.totalMembers}</p>
                </div>
                <div className="bg-secondary/50 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Monthly</p>
                  <p className="text-sm font-semibold mt-1">{formatCurrency(entity.monthlyContribution)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Contributions & Insurance Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={contributionTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v: number, name: string) => [`R${v.toLocaleString()}`, name === "contributions" ? "Contributions" : "Insurance"]}
                />
                <Bar dataKey="contributions" fill="hsl(227, 71%, 55%)" radius={[4, 4, 0, 0]} name="contributions" />
                <Bar dataKey="insurance" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} name="insurance" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Member Status</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={memberStatusData} cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" stroke="none">
                  {memberStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-1.5 mt-2">
              {memberStatusData.map((item) => (
                <div key={item.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
                    <span className="text-muted-foreground">{item.name}</span>
                  </div>
                  <span className="font-medium">{item.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Allocation + Insurance Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>Capital Allocation by Strategy</span>
              <Badge variant="secondary" className="font-normal text-xs">{allocationByStrategy.length} strategies</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={allocationByStrategy} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" stroke="none">
                  {allocationByStrategy.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-1.5 mt-2">
              {allocationByStrategy.map((item, i) => (
                <div key={item.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-muted-foreground">{item.name}</span>
                  </div>
                  <span className="font-medium">{formatCurrency(item.value)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>Insurance Products</span>
              <Badge variant="secondary" className="font-normal text-xs">200% markup</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {insuranceProducts.filter(p => p.status === "available").map((product) => {
                const enrolled = insuredMembers.filter(m => m.insuranceProducts.includes(product.id)).length;
                const margin = calcInsuranceMargin(product);
                return (
                  <div key={product.id} className="flex items-center justify-between px-6 py-3 hover:bg-secondary/50 transition-colors">
                    <div>
                      <p className="text-sm font-medium">{product.name}</p>
                      <p className="text-xs text-muted-foreground">{product.underwriter} · {enrolled} enrolled</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">R{product.mintPremium}/pm</p>
                      <p className="text-[10px] text-ticker-positive">+R{margin}/pm margin</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Members */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center justify-between">
            <span>Members Overview</span>
            <Badge variant="secondary" className="font-normal text-xs">{members.length} total</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {members.map((member) => (
              <div key={member.id} className="flex items-center justify-between px-6 py-3 hover:bg-secondary/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold",
                    member.role === "employee" ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning"
                  )}>
                    {member.name.split(" ").map(n => n[0]).join("")}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{member.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {member.role === "employee" ? "Employee" : "Stokvel Member"} · {member.strategiesAllocated.length} strategies · {member.insuranceProducts.length} policies
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-medium">{member.currentValue > 0 ? formatCurrency(member.currentValue) : "—"}</p>
                    {member.totalInvested > 0 && (
                      <p className={cn("text-[10px]", member.currentValue >= member.totalInvested ? "text-ticker-positive" : "text-ticker-negative")}>
                        {member.currentValue >= member.totalInvested ? "+" : ""}
                        {((member.currentValue - member.totalInvested) / member.totalInvested * 100).toFixed(1)}%
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary" className={cn("text-[10px] font-medium",
                    member.status === "active" && "bg-success/10 text-success",
                    member.status === "pending_kyc" && "bg-warning/10 text-warning",
                    member.status === "onboarding" && "bg-primary/10 text-primary",
                  )}>
                    {member.status === "pending_kyc" ? "Pending KYC" : member.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
