import { useState } from "react";
import { Search, Plus, Upload, UserPlus, Building2, Landmark, Mail, Phone, Shield, TrendingUp } from "lucide-react";
import { members, businessEntities, insuranceProducts, getMembersByType } from "@/lib/businessMockData";
import { formatCurrency, strategies } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export default function BusinessMembers() {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [onboardType, setOnboardType] = useState<"employee" | "member">("employee");

  const filtered = members.filter((m) => {
    const matchSearch = m.name.toLowerCase().includes(search.toLowerCase()) || m.email.toLowerCase().includes(search.toLowerCase());
    const matchTab = tab === "all" || (tab === "employees" && m.role === "employee") || (tab === "members" && m.role === "member") || (tab === "pending" && (m.status === "pending_kyc" || m.status === "onboarding"));
    return matchSearch && matchTab;
  });

  const employees = getMembersByType("employee");
  const stokvelMembers = getMembersByType("member");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage employees & stokvel members</p>
        </div>
        <Dialog open={onboardOpen} onOpenChange={setOnboardOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2"><UserPlus className="h-4 w-4" /> Onboard Member</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Onboard New Member</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs font-medium">Member Type</Label>
                <Select value={onboardType} onValueChange={(v) => setOnboardType(v as "employee" | "member")}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee (Employer Group)</SelectItem>
                    <SelectItem value="member">Stokvel Member</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {onboardType === "employee" && (
                <div>
                  <Label className="text-xs font-medium">Employer</Label>
                  <Select>
                    <SelectTrigger className="mt-1.5">
                      <SelectValue placeholder="Select employer..." />
                    </SelectTrigger>
                    <SelectContent>
                      {businessEntities.filter(b => b.type === "employer").map(b => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {onboardType === "member" && (
                <div>
                  <Label className="text-xs font-medium">Stokvel Group</Label>
                  <Select>
                    <SelectTrigger className="mt-1.5">
                      <SelectValue placeholder="Select stokvel..." />
                    </SelectTrigger>
                    <SelectContent>
                      {businessEntities.filter(b => b.type === "stokvel").map(b => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs font-medium">Full Name</Label>
                  <Input placeholder="e.g. Sipho Dlamini" className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs font-medium">ID Number</Label>
                  <Input placeholder="e.g. 9001015800083" className="mt-1.5" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs font-medium">Email</Label>
                  <Input placeholder="email@example.com" className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs font-medium">Phone</Label>
                  <Input placeholder="+27 XX XXX XXXX" className="mt-1.5" />
                </div>
              </div>

              {onboardType === "employee" && (
                <div>
                  <Label className="text-xs font-medium">Monthly Salary</Label>
                  <Input placeholder="e.g. 45000" type="number" className="mt-1.5" />
                </div>
              )}

              {onboardType === "member" && (
                <div>
                  <Label className="text-xs font-medium">Monthly Contribution</Label>
                  <Input placeholder="e.g. 2000" type="number" className="mt-1.5" />
                </div>
              )}

              <div>
                <Label className="text-xs font-medium">Documents</Label>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {["ID Document", "Proof of Address", "Proof of Income", "Bank Statement"].map((doc) => (
                    <div key={doc} className="flex items-center gap-2 p-2.5 rounded-lg border border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors">
                      <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{doc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOnboardOpen(false)}>Cancel</Button>
              <Button onClick={() => setOnboardOpen(false)} className="gap-2">
                <Shield className="h-4 w-4" /> Submit to Compliance
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Building2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Employees</p>
                <p className="text-lg font-semibold">{employees.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-warning/10 text-warning flex items-center justify-center">
                <Landmark className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Stokvel Members</p>
                <p className="text-lg font-semibold">{stokvelMembers.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center">
                <Shield className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pending Approval</p>
                <p className="text-lg font-semibold">{members.filter(m => m.status === "pending_kyc" || m.status === "onboarding").length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search members..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all" className="text-xs">All ({members.length})</TabsTrigger>
            <TabsTrigger value="employees" className="text-xs">Employees ({employees.length})</TabsTrigger>
            <TabsTrigger value="members" className="text-xs">Stokvel ({stokvelMembers.length})</TabsTrigger>
            <TabsTrigger value="pending" className="text-xs">Pending ({members.filter(m => m.status === "pending_kyc" || m.status === "onboarding").length})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Members List */}
      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {/* Header */}
            <div className="grid grid-cols-12 gap-4 px-6 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/50">
              <div className="col-span-3">Member</div>
              <div className="col-span-2">Type</div>
              <div className="col-span-2 text-right">Invested</div>
              <div className="col-span-2 text-center">Products</div>
              <div className="col-span-2 text-center">Status</div>
              <div className="col-span-1"></div>
            </div>
            {filtered.map((member) => (
              <div key={member.id} className="grid grid-cols-12 gap-4 px-6 py-3 items-center hover:bg-secondary/50 transition-colors">
                <div className="col-span-3 flex items-center gap-3">
                  <div className={cn(
                    "h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0",
                    member.role === "employee" ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning"
                  )}>
                    {member.name.split(" ").map(n => n[0]).join("")}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{member.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  </div>
                </div>
                <div className="col-span-2">
                  <Badge variant="outline" className="text-[10px]">
                    {member.role === "employee" ? (
                      <><Building2 className="h-3 w-3 mr-1" />Employee</>
                    ) : (
                      <><Landmark className="h-3 w-3 mr-1" />Stokvel</>
                    )}
                  </Badge>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {member.role === "employee" ? `R${member.salary?.toLocaleString()}/mo` : `R${member.contribution?.toLocaleString()}/mo`}
                  </p>
                </div>
                <div className="col-span-2 text-right">
                  <p className="text-sm font-medium">{member.currentValue > 0 ? formatCurrency(member.currentValue) : "—"}</p>
                  {member.totalInvested > 0 && (
                    <p className={cn("text-[10px]", member.currentValue >= member.totalInvested ? "text-ticker-positive" : "text-ticker-negative")}>
                      {((member.currentValue - member.totalInvested) / member.totalInvested * 100).toFixed(1)}% return
                    </p>
                  )}
                </div>
                <div className="col-span-2 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-xs flex items-center gap-1">
                      <TrendingUp className="h-3 w-3 text-primary" /> {member.strategiesAllocated.length}
                    </span>
                    <span className="text-xs flex items-center gap-1">
                      <Shield className="h-3 w-3 text-success" /> {member.insuranceProducts.length}
                    </span>
                  </div>
                </div>
                <div className="col-span-2 text-center">
                  <Badge variant="secondary" className={cn("text-[10px] font-medium",
                    member.status === "active" && "bg-success/10 text-success",
                    member.status === "pending_kyc" && "bg-warning/10 text-warning",
                    member.status === "onboarding" && "bg-primary/10 text-primary",
                    member.status === "suspended" && "bg-destructive/10 text-destructive",
                  )}>
                    {member.status === "pending_kyc" ? "Pending KYC" : member.status}
                  </Badge>
                </div>
                <div className="col-span-1 text-right">
                  <Button variant="ghost" size="sm" className="text-xs h-7">View</Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
