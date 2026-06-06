import { TrendingUp, Users, DollarSign, Briefcase, ArrowUpRight, ArrowDownRight } from "lucide-react";
import StatCard from "@/components/StatCard";
import { clients, strategies, formatCurrency, formatPct, getStrategistNames } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";

const activeClients = clients.filter((c) => c.status === "active");
const totalAUM = activeClients.reduce((s, c) => s + c.aum, 0);
const totalCash = activeClients.reduce((s, c) => s + c.cashBalance, 0);
const annualFee = totalAUM * 0.001; // 0.1% for WM
const perfFeePool = strategies.reduce((s, st) => s + (st.aum * Math.max(0, st.ytdReturn / 100) * 0.20), 0);
const wmCommission = perfFeePool * 0.13;

const performanceData = Array.from({ length: 13 }, (_, i) => {
  const month = new Date(2025, 6 + i, 1);
  return {
    date: month.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" }),
    portfolio: +(100 + Math.random() * 8 + i * 0.5).toFixed(2),
    benchmark: +(100 + Math.random() * 5 + i * 0.3).toFixed(2),
  };
});

const allocationData = [
  { name: "MINT ETF Basket", value: 55800000, color: "hsl(227, 71%, 55%)" },
  { name: "SA Equity Growth", value: 55200000, color: "hsl(142, 71%, 45%)" },
  { name: "Global Balanced", value: 23000000, color: "hsl(38, 92%, 50%)" },
  { name: "Custom High Yield", value: 18000000, color: "hsl(262, 60%, 55%)" },
  { name: "Income Fund", value: 29000000, color: "hsl(0, 84%, 60%)" },
];

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Overview of your book · {new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total AUM" value={formatCurrency(totalAUM)} change="+3.2% MTD" changeType="positive" icon={<Briefcase className="h-4 w-4" />} />
        <StatCard label="Active Clients" value={activeClients.length.toString()} subtitle={`${clients.filter(c => c.status !== "active").length} pending`} icon={<Users className="h-4 w-4" />} />
        <StatCard label="AUM Fee (0.1%)" value={formatCurrency(annualFee)} subtitle="annualised" icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Performance Commission" value={formatCurrency(wmCommission)} change="13% of perf fees" changeType="neutral" icon={<TrendingUp className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Aggregate Portfolio Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={performanceData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(220, 9%, 46%)" domain={['dataMin - 1', 'dataMax + 1']} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="portfolio" stroke="hsl(227, 71%, 55%)" strokeWidth={2} dot={false} name="Portfolio" />
                <Line type="monotone" dataKey="benchmark" stroke="hsl(220, 9%, 46%)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} name="Benchmark" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">AUM by Strategy</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={allocationData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" stroke="none">
                  {allocationData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-1.5 mt-2">
              {allocationData.map((item) => (
                <div key={item.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
                    <span className="text-muted-foreground">{item.name}</span>
                  </div>
                  <span className="font-medium">{formatCurrency(item.value)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>Client Book</span>
              <Badge variant="secondary" className="font-normal text-xs">{clients.length} total</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {clients.map((client) => (
                <div key={client.id} className="flex items-center justify-between px-6 py-3 hover:bg-secondary/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{client.name}</p>
                    <p className="text-xs text-muted-foreground">{client.strategies.length} strategies · {client.tier}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{client.aum > 0 ? formatCurrency(client.aum) : "—"}</p>
                    <Badge variant="secondary" className={cn("text-[10px] font-medium",
                      client.status === "active" && "bg-success/10 text-success",
                      client.status === "pending_kyc" && "bg-warning/10 text-warning",
                      client.status === "onboarding" && "bg-primary/10 text-primary",
                    )}>
                      {client.status === "pending_kyc" ? "Pending KYC" : client.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>Platform Strategies</span>
              <Badge variant="secondary" className="font-normal text-xs">{strategies.length} available</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {strategies.map((strategy) => (
                <div key={strategy.id} className="flex items-center justify-between px-6 py-3 hover:bg-secondary/50 transition-colors">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{strategy.name}</p>
                      {strategy.type === "custom" && <Badge variant="outline" className="text-[10px] h-4">Custom</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{getStrategistNames(strategy.managerIds)} · {strategy.instruments} instruments</p>
                  </div>
                  <div className="text-right flex items-center gap-3">
                    <div>
                      <p className={cn("text-sm font-medium flex items-center gap-1", strategy.ytdReturn >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                        {strategy.ytdReturn >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {formatPct(strategy.ytdReturn)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">YTD</p>
                    </div>
                    <Badge variant="secondary" className={cn("text-[10px]",
                      strategy.status === "approved" && "bg-success/10 text-success",
                      strategy.status === "pending" && "bg-warning/10 text-warning",
                    )}>
                      {strategy.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
