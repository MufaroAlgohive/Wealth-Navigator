import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fcGroups, groupTypeLabels, groupTypeColors, statusColors, formatCurrency, type GroupType, type GroupStatus } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Users, Heart, DollarSign, Search, Plus, Calendar, TrendingUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export default function FCGroups() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const navigate = useNavigate();

  const filtered = fcGroups.filter(g => {
    if (search && !g.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (typeFilter !== "all" && g.type !== typeFilter) return false;
    if (statusFilter !== "all" && g.status !== statusFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{fcGroups.length} groups · {fcGroups.filter(g => g.status === "active").length} active</p>
        </div>
        <Button><Plus className="h-4 w-4 mr-2" />Add Group</Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search groups..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-9 text-sm" />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[160px] h-9 text-sm"><SelectValue placeholder="All Types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="employer">Employer</SelectItem>
            <SelectItem value="stokvel">Stokvel</SelectItem>
            <SelectItem value="church">Church</SelectItem>
            <SelectItem value="parlour">Funeral Parlour</SelectItem>
            <SelectItem value="community">Community</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px] h-9 text-sm"><SelectValue placeholder="All Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="pending_approval">Pending Approval</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Group Cards */}
      <div className="space-y-3">
        {filtered.map(group => (
          <Card key={group.id} className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => navigate(`/fc/groups/${group.id}`)}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={cn("h-11 w-11 rounded-lg flex items-center justify-center", groupTypeColors[group.type])}>
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">{group.name}</p>
                      <Badge variant="outline" className="text-[10px]">{groupTypeLabels[group.type]}</Badge>
                      <Badge variant="secondary" className={cn("text-[10px]", statusColors[group.status])}>
                        {group.status.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase())}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Users className="h-3 w-3" />{group.principalMembers} members</span>
                      <span className="flex items-center gap-1"><Heart className="h-3 w-3" />{group.coveredLives} lives</span>
                      <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />Joined {new Date(group.joinedDate).toLocaleDateString("en-ZA")}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className="text-sm font-semibold">{formatCurrency(group.monthlyPremium)}</p>
                    <p className="text-[10px] text-muted-foreground">monthly premium</p>
                  </div>
                  <div className="text-right">
                    <p className={cn("text-sm font-semibold", group.collectionRate >= 95 ? "text-success" : group.collectionRate >= 85 ? "text-warning" : "text-destructive")}>
                      {group.collectionRate}%
                    </p>
                    <p className="text-[10px] text-muted-foreground">collection rate</p>
                  </div>
                  {group.arrears > 0 && (
                    <div className="text-right">
                      <p className="text-sm font-semibold text-destructive">{formatCurrency(group.arrears)}</p>
                      <p className="text-[10px] text-muted-foreground">arrears</p>
                    </div>
                  )}
                  {group.lastPaymentDate && (
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{new Date(group.lastPaymentDate).toLocaleDateString("en-ZA")}</p>
                      <p className="text-[10px] text-muted-foreground">last payment</p>
                    </div>
                  )}
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
