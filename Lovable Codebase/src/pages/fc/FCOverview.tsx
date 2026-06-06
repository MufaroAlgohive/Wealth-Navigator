import {
  fcGroups, fcMembers, fcClaims, fcPayments, recentActivity,
  getTotalGroups, getTotalPrincipalMembers, getTotalCoveredLives,
  getTotalMonthlyPremium, getTotalArrears, getAverageCollectionRate,
  getPendingApplications, getMissingDocuments, getClaimsThisMonth,
  formatCurrency, statusColors, groupTypeLabels,
} from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import StatCard from "@/components/StatCard";
import {
  Users, Building2, Shield, Clock, FileText, DollarSign,
  AlertTriangle, TrendingUp, Activity, CheckCircle, XCircle,
  AlertCircle, Heart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from "recharts";

const activeGroups = fcGroups.filter(g => g.status === "active");
const totalPremium = getTotalMonthlyPremium();
const costPrice = Math.round(totalPremium / 3.5);
const monthlyMargin = totalPremium - costPrice;

const policyBreakdown = [
  { name: "Active", value: fcMembers.filter(m => m.policyStatus === "active").length, color: "hsl(142,71%,45%)" },
  { name: "Waiting", value: fcMembers.filter(m => m.policyStatus === "waiting_period").length, color: "hsl(38,92%,50%)" },
  { name: "Lapsed", value: fcMembers.filter(m => m.policyStatus === "lapsed").length, color: "hsl(0,84%,60%)" },
];

const onboardingFunnel = [
  { stage: "Draft", count: fcMembers.filter(m => m.onboardingStatus === "draft").length },
  { stage: "Submitted", count: fcMembers.filter(m => m.onboardingStatus === "submitted").length },
  { stage: "Missing Docs", count: fcMembers.filter(m => m.onboardingStatus === "missing_documents").length },
  { stage: "In Review", count: fcMembers.filter(m => m.onboardingStatus === "in_review").length },
  { stage: "Approved", count: fcMembers.filter(m => m.onboardingStatus === "approved").length },
  { stage: "Active", count: fcMembers.filter(m => m.onboardingStatus === "active").length },
];

const monthlyCollections = [
  { month: "Jan", collected: 385000, expected: 395000 },
  { month: "Feb", collected: 388000, expected: 395000 },
  { month: "Mar", collected: 371000, expected: 395280 },
  { month: "Apr", collected: 375820, expected: 395280 },
];

const severityIcon: Record<string, React.ElementType> = {
  info: Activity, warning: AlertTriangle, critical: XCircle, success: CheckCircle,
};
const severityColor: Record<string, string> = {
  info: "text-primary", warning: "text-warning", critical: "text-destructive", success: "text-success",
};

export default function FCOverview() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Funeral Cover Operations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Group funeral cover management · {new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}</p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Groups" value={getTotalGroups().toString()} subtitle={`${activeGroups.length} active`} icon={<Building2 className="h-4 w-4" />} />
        <StatCard label="Active Members" value={getTotalPrincipalMembers().toString()} icon={<Users className="h-4 w-4" />} />
        <StatCard label="Covered Lives" value={getTotalCoveredLives().toLocaleString()} icon={<Heart className="h-4 w-4" />} />
        <StatCard label="Pending Applications" value={getPendingApplications().toString()} subtitle={`${getMissingDocuments()} docs outstanding`} icon={<Clock className="h-4 w-4" />} changeType="neutral" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Active Premium Value" value={formatCurrency(totalPremium)} subtitle="monthly collection" icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Monthly Margin" value={formatCurrency(monthlyMargin)} change="250% markup" changeType="positive" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Collection Rate" value={`${getAverageCollectionRate().toFixed(1)}%`} icon={<Shield className="h-4 w-4" />} changeType="positive" />
        <StatCard label="Claims This Month" value={getClaimsThisMonth().length.toString()} subtitle={`R${getClaimsThisMonth().reduce((s, c) => s + c.amount, 0).toLocaleString()} value`} icon={<FileText className="h-4 w-4" />} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Onboarding Funnel */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Onboarding Funnel</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={onboardingFunnel} layout="vertical">
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="stage" width={80} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => [v, "Members"]} />
                <Bar dataKey="count" fill="hsl(227,71%,55%)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Collections vs Expected */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Collections vs Expected</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={monthlyCollections}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,13%,91%)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number) => [`R${v.toLocaleString()}`, ""]} />
                <Line type="monotone" dataKey="expected" stroke="hsl(220,9%,46%)" strokeDasharray="5 5" strokeWidth={1.5} dot={false} name="Expected" />
                <Line type="monotone" dataKey="collected" stroke="hsl(142,71%,45%)" strokeWidth={2} dot={{ r: 3 }} name="Collected" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Policy Status Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Policy Status</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-center">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={policyBreakdown} cx="50%" cy="50%" innerRadius={50} outerRadius={75} dataKey="value" paddingAngle={4}>
                  {policyBreakdown.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number, name: string) => [v, name]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-2 ml-2">
              {policyBreakdown.map((item) => (
                <div key={item.name} className="flex items-center gap-2 text-xs">
                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-muted-foreground">{item.name}</span>
                  <span className="font-semibold">{item.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Alerts + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Alerts */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              Operational Alerts
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {getTotalArrears() > 0 && (
                <div className="px-5 py-3 flex items-start gap-3">
                  <div className="h-7 w-7 rounded-lg bg-destructive/10 flex items-center justify-center mt-0.5"><DollarSign className="h-3.5 w-3.5 text-destructive" /></div>
                  <div><p className="text-sm font-medium">Arrears Outstanding</p><p className="text-xs text-muted-foreground">{formatCurrency(getTotalArrears())} total arrears across all groups</p></div>
                </div>
              )}
              {getMissingDocuments() > 0 && (
                <div className="px-5 py-3 flex items-start gap-3">
                  <div className="h-7 w-7 rounded-lg bg-warning/10 flex items-center justify-center mt-0.5"><FileText className="h-3.5 w-3.5 text-warning" /></div>
                  <div><p className="text-sm font-medium">Documents Outstanding</p><p className="text-xs text-muted-foreground">{getMissingDocuments()} members with missing KYC documents</p></div>
                </div>
              )}
              {fcGroups.filter(g => g.status === "suspended").map(g => (
                <div key={g.id} className="px-5 py-3 flex items-start gap-3">
                  <div className="h-7 w-7 rounded-lg bg-destructive/10 flex items-center justify-center mt-0.5"><XCircle className="h-3.5 w-3.5 text-destructive" /></div>
                  <div><p className="text-sm font-medium">{g.name} Suspended</p><p className="text-xs text-muted-foreground">{formatCurrency(g.arrears)} in arrears · Collection rate {g.collectionRate}%</p></div>
                </div>
              ))}
              {fcMembers.filter(m => m.policyStatus === "waiting_period").length > 0 && (
                <div className="px-5 py-3 flex items-start gap-3">
                  <div className="h-7 w-7 rounded-lg bg-warning/10 flex items-center justify-center mt-0.5"><Clock className="h-3.5 w-3.5 text-warning" /></div>
                  <div><p className="text-sm font-medium">Waiting Period</p><p className="text-xs text-muted-foreground">{fcMembers.filter(m => m.policyStatus === "waiting_period").length} members in waiting period</p></div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
              {recentActivity.map((item) => {
                const Icon = severityIcon[item.severity];
                return (
                  <div key={item.id} className="px-5 py-3 flex items-start gap-3">
                    <div className={cn("mt-0.5", severityColor[item.severity])}><Icon className="h-4 w-4" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs leading-relaxed">{item.message}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(item.timestamp).toLocaleDateString("en-ZA")} · {new Date(item.timestamp).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
