import { useState } from "react";
import { Search, ArrowUpRight, ArrowDownRight, Filter, TrendingUp, BarChart3, Users } from "lucide-react";
import { strategies, formatCurrency, formatPct, getStrategistNames } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useRole } from "@/contexts/RoleContext";

export default function Marketplace() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const { role } = useRole();

  const filtered = strategies.filter((s) => {
    const matchesSearch = s.name.toLowerCase().includes(search.toLowerCase()) || getStrategistNames(s.managerIds).toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === "all" || s.type === typeFilter;
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Strategy Marketplace</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Browse all available investment strategies on the platform</p>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search strategies or managers..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[140px]">
            <Filter className="h-3.5 w-3.5 mr-2" />
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
            <SelectItem value="paper">Paper</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((strategy) => (
          <Card key={strategy.id} className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">{strategy.name}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">{getStrategistNames(strategy.managerIds)}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">{strategy.type}</Badge>
                  <Badge variant="secondary" className={cn("text-[10px]",
                    strategy.status === "approved" && "bg-success/10 text-success",
                    strategy.status === "pending" && "bg-warning/10 text-warning",
                  )}>
                    {strategy.status}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground leading-relaxed">{strategy.description}</p>

              <div className="grid grid-cols-4 gap-2">
                <div className="bg-secondary/50 rounded-lg p-2 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">YTD</p>
                  <p className={cn("text-sm font-semibold mt-0.5 flex items-center justify-center gap-0.5", strategy.ytdReturn >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                    {strategy.ytdReturn >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {formatPct(strategy.ytdReturn)}
                  </p>
                </div>
                <div className="bg-secondary/50 rounded-lg p-2 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Sharpe</p>
                  <p className="text-sm font-semibold mt-0.5">{strategy.sharpeRatio.toFixed(2)}</p>
                </div>
                <div className="bg-secondary/50 rounded-lg p-2 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Vol</p>
                  <p className="text-sm font-semibold mt-0.5">{strategy.volatility.toFixed(1)}%</p>
                </div>
                <div className="bg-secondary/50 rounded-lg p-2 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">DD</p>
                  <p className="text-sm font-semibold mt-0.5 text-ticker-negative">{strategy.maxDrawdown.toFixed(1)}%</p>
                </div>
              </div>

              {/* Sector Exposure */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Sector Exposure</p>
                <div className="space-y-1">
                  {strategy.sectorExposure.slice(0, 3).map((sec) => (
                    <div key={sec.sector} className="flex items-center gap-2 text-[10px]">
                      <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${sec.weight}%` }} />
                      </div>
                      <span className="text-muted-foreground w-16 truncate">{sec.sector}</span>
                      <span className="font-medium w-6 text-right">{sec.weight}%</span>
                    </div>
                  ))}
                  {strategy.sectorExposure.length > 3 && (
                    <p className="text-[10px] text-muted-foreground">+{strategy.sectorExposure.length - 3} more</p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-border">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {strategy.investorCount}</span>
                  <span className="flex items-center gap-1"><BarChart3 className="h-3 w-3" /> {strategy.instruments} inst.</span>
                  <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" /> {formatCurrency(strategy.aum)}</span>
                </div>
                {role === "wealth_manager" && (
                  <Button size="sm" variant="outline" disabled={strategy.status !== "approved"}>
                    Allocate
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
