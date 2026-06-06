import { useState } from "react";
import { Shield, Users, DollarSign, CheckCircle2, ArrowUpRight, TrendingUp } from "lucide-react";
import { insuranceProducts, members, calcInsuranceMargin, getActiveMembers, MARKUP_MULTIPLIER } from "@/lib/businessMockData";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import StatCard from "@/components/StatCard";
import FuneralEnrolFlow from "@/components/FuneralEnrolFlow";

const activeMembers = getActiveMembers();
const insuredMembers = activeMembers.filter(m => m.insuranceProducts.length > 0);

const totalMonthlyPremiums = insuredMembers.reduce((sum, m) => {
  return sum + m.insuranceProducts.reduce((ps, pid) => {
    const product = insuranceProducts.find(p => p.id === pid);
    return ps + (product ? product.mintPremium : 0);
  }, 0);
}, 0);

const totalMonthlyMargin = insuredMembers.reduce((sum, m) => {
  return sum + m.insuranceProducts.reduce((ps, pid) => {
    const product = insuranceProducts.find(p => p.id === pid);
    return ps + (product ? calcInsuranceMargin(product) : 0);
  }, 0);
}, 0);

const totalPolicies = insuredMembers.reduce((sum, m) => sum + m.insuranceProducts.length, 0);

export default function BusinessInsurance() {
  const [enrolOpen, setEnrolOpen] = useState(false);

  if (enrolOpen) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Enrol in Funeral Cover</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Dynamic pricing with {MARKUP_MULTIPLIER}× markup ({((MARKUP_MULTIPLIER - 1) * 100).toFixed(0)}% margin)</p>
        </div>
        <FuneralEnrolFlow onClose={() => setEnrolOpen(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Insurance Products</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Group insurance solutions with {((MARKUP_MULTIPLIER - 1) * 100).toFixed(0)}% markup · Powered by Mint</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Monthly Premiums" value={`R${totalMonthlyPremiums.toLocaleString()}`} subtitle="collected from members" icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Monthly Margin" value={`R${totalMonthlyMargin.toLocaleString()}`} change={`${((MARKUP_MULTIPLIER - 1) * 100).toFixed(0)}% markup`} changeType="positive" icon={<ArrowUpRight className="h-4 w-4" />} />
        <StatCard label="Active Policies" value={totalPolicies.toString()} subtitle={`across ${insuredMembers.length} members`} icon={<Shield className="h-4 w-4" />} />
        <StatCard label="Annual Revenue" value={`R${(totalMonthlyMargin * 12).toLocaleString()}`} subtitle="projected margin" icon={<TrendingUp className="h-4 w-4" />} />
      </div>

      {/* Products */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {insuranceProducts.map((product) => {
          const enrolled = members.filter(m => m.insuranceProducts.includes(product.id) && m.status === "active").length;
          const margin = calcInsuranceMargin(product);
          const isAvailable = product.status === "available";
          const isFuneral = product.category === "funeral";

          return (
            <Card key={product.id} className={cn("transition-shadow", isAvailable ? "hover:shadow-md" : "opacity-60", isFuneral && "ring-1 ring-primary/30")}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "h-10 w-10 rounded-lg flex items-center justify-center",
                      product.category === "life" && "bg-primary/10 text-primary",
                      product.category === "funeral" && "bg-muted text-muted-foreground",
                      product.category === "income_protection" && "bg-success/10 text-success",
                      product.category === "disability" && "bg-warning/10 text-warning",
                      product.category === "group_cover" && "bg-destructive/10 text-destructive",
                    )}>
                      <Shield className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-sm font-semibold">{product.name}</CardTitle>
                      <p className="text-xs text-muted-foreground">{product.underwriter}</p>
                    </div>
                  </div>
                  <Badge variant="secondary" className={cn("text-[10px]",
                    isAvailable ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                  )}>
                    {isAvailable ? "Available" : "Coming Soon"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground leading-relaxed">{product.description}</p>

                <div className="bg-secondary/50 rounded-lg p-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Cost</p>
                      <p className="text-xs font-medium mt-0.5 line-through text-muted-foreground">R{product.basePremium}/pm</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Client Pays</p>
                      <p className="text-sm font-semibold mt-0.5">R{product.mintPremium}/pm</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Margin</p>
                      <p className="text-sm font-semibold mt-0.5 text-ticker-positive">R{margin}/pm</p>
                    </div>
                  </div>
                  {product.coverAmount > 0 && (
                    <p className="text-[10px] text-center text-muted-foreground mt-2">Cover: R{product.coverAmount.toLocaleString()}</p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Key Features</p>
                  <div className="space-y-1">
                    {product.features.map((f, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3 w-3 text-success mt-0.5 shrink-0" />
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    <span>{enrolled} enrolled</span>
                  </div>
                  {isFuneral ? (
                    <Button size="sm" onClick={() => setEnrolOpen(true)}>Enrol Members</Button>
                  ) : (
                    <Button size="sm" variant={isAvailable ? "default" : "outline"} disabled={!isAvailable}>
                      {isAvailable ? "Enrol Members" : "Notify Me"}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Enrolled Members Breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Enrolled Members</CardTitle>
          <CardDescription className="text-xs">Members with active insurance policies</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            <div className="grid grid-cols-12 gap-4 px-6 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/50">
              <div className="col-span-3">Member</div>
              <div className="col-span-4">Policies</div>
              <div className="col-span-2 text-right">Monthly Premium</div>
              <div className="col-span-2 text-right">Margin</div>
              <div className="col-span-1"></div>
            </div>
            {insuredMembers.map((member) => {
              const memberProducts = member.insuranceProducts
                .map(id => insuranceProducts.find(p => p.id === id))
                .filter(Boolean) as typeof insuranceProducts;
              const totalPrem = memberProducts.reduce((s, p) => s + p.mintPremium, 0);
              const totalMarg = memberProducts.reduce((s, p) => s + calcInsuranceMargin(p), 0);

              return (
                <div key={member.id} className="grid grid-cols-12 gap-4 px-6 py-3 items-center hover:bg-secondary/50 transition-colors">
                  <div className="col-span-3">
                    <p className="text-sm font-medium">{member.name}</p>
                    <p className="text-xs text-muted-foreground">{member.role === "employee" ? "Employee" : "Stokvel"}</p>
                  </div>
                  <div className="col-span-4 flex flex-wrap gap-1">
                    {memberProducts.map(p => (
                      <Badge key={p.id} variant="outline" className="text-[10px]">{p.name}</Badge>
                    ))}
                  </div>
                  <div className="col-span-2 text-right">
                    <p className="text-sm font-medium">R{totalPrem}/pm</p>
                  </div>
                  <div className="col-span-2 text-right">
                    <p className="text-sm font-medium text-ticker-positive">R{totalMarg}/pm</p>
                  </div>
                  <div className="col-span-1 text-right">
                    <Button variant="ghost" size="sm" className="text-xs h-7">Manage</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
