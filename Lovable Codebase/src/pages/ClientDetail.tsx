import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, ArrowDownRight, Plus, Wallet, TrendingUp, Minus, LogOut as ExitIcon } from "lucide-react";
import { clients, strategies, formatCurrency, formatPct } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import StatCard from "@/components/StatCard";
import { cn } from "@/lib/utils";
import { useRole } from "@/contexts/RoleContext";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

export default function ClientDetail() {
  const { id } = useParams();
  const { role } = useRole();
  const client = clients.find((c) => c.id === id);

  if (!client) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Client not found.</p>
      </div>
    );
  }

  const totalAllocated = client.strategies.reduce((s, c) => s + c.allocated, 0);
  const totalValue = client.strategies.reduce((s, c) => s + c.currentValue, 0);
  const totalReturn = totalValue - totalAllocated;
  const totalReturnPct = totalAllocated > 0 ? (totalReturn / totalAllocated) * 100 : 0;
  const aumFee = client.aum * 0.001;

  const perfData = Array.from({ length: 12 }, (_, i) => ({
    month: new Date(2025, 7 + i, 1).toLocaleDateString("en-ZA", { month: "short" }),
    value: +(100 + Math.random() * 6 + i * 0.6).toFixed(2),
  }));

  const isWM = role === "wealth_manager";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/clients">
          <Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
          <p className="text-sm text-muted-foreground">{client.email} · {client.phone} · {client.tier} tier</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Badge className={cn("text-xs",
            client.status === "active" && "bg-success/10 text-success border-success/20",
            client.status === "pending_kyc" && "bg-warning/10 text-warning border-warning/20",
          )} variant="outline">
            {client.status === "pending_kyc" ? "Pending KYC" : client.status}
          </Badge>
          {isWM && client.status === "active" && (
            <Button size="sm" className="gap-2"><Plus className="h-3.5 w-3.5" />Allocate to Strategy</Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Total AUM" value={formatCurrency(client.aum)} icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Cash Balance" value={formatCurrency(client.cashBalance)} icon={<Wallet className="h-4 w-4" />} />
        <StatCard label="Invested" value={formatCurrency(totalAllocated)} />
        <StatCard label="Total Return" value={formatCurrency(Math.abs(totalReturn))} change={formatPct(totalReturnPct)} changeType={totalReturnPct >= 0 ? "positive" : "negative"} />
        <StatCard label="Annual AUM Fee" value={formatCurrency(aumFee)} subtitle="0.1% p.a." />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Portfolio Growth (indexed to 100)</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
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
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Allocation Summary</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="bg-secondary/50 rounded-lg p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Unallocated Cash</p>
              <p className="text-xl font-semibold mt-1">{formatCurrency(client.cashBalance)}</p>
              {client.aum > 0 && (
                <>
                  <div className="h-1.5 bg-border rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${(totalAllocated / client.aum) * 100}%` }} />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">{((totalAllocated / client.aum) * 100).toFixed(1)}% allocated</p>
                </>
              )}
            </div>
            {client.strategies.map((s) => (
              <div key={s.strategyId} className="flex items-center justify-between py-1.5">
                <div>
                  <p className="text-xs font-medium">{s.strategyName}</p>
                  <p className="text-[10px] text-muted-foreground">{formatCurrency(s.currentValue)}</p>
                </div>
                <span className={cn("text-xs font-medium", s.returnPct >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                  {formatPct(s.returnPct)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm font-medium">Strategy Allocations</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Strategy</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Allocated</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Current Value</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">P&L</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Return</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Since</th>
                {isWM && <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {client.strategies.map((s) => {
                const pnl = s.currentValue - s.allocated;
                return (
                  <tr key={s.strategyId} className="hover:bg-secondary/50">
                    <td className="px-6 py-3 text-sm font-medium">{s.strategyName}</td>
                    <td className="text-right px-6 py-3 text-sm">{formatCurrency(s.allocated)}</td>
                    <td className="text-right px-6 py-3 text-sm font-medium">{formatCurrency(s.currentValue)}</td>
                    <td className={cn("text-right px-6 py-3 text-sm font-medium", pnl >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                      {pnl >= 0 ? "+" : ""}{formatCurrency(Math.abs(pnl))}
                    </td>
                    <td className="text-right px-6 py-3">
                      <span className={cn("text-sm font-medium flex items-center justify-end gap-1", s.returnPct >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                        {s.returnPct >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {formatPct(s.returnPct)}
                      </span>
                    </td>
                    <td className="text-right px-6 py-3 text-xs text-muted-foreground">{new Date(s.allocatedDate).toLocaleDateString("en-ZA", { month: "short", year: "numeric" })}</td>
                    {isWM && (
                      <td className="text-right px-6 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"><Plus className="h-3 w-3" />Add</Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"><Minus className="h-3 w-3" />Reduce</Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-destructive"><ExitIcon className="h-3 w-3" />Exit</Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
