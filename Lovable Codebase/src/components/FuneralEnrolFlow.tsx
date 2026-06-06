import { useState, useMemo } from "react";
import {
  Shield, Users, CheckCircle2, ChevronRight, ChevronLeft, Plus, Minus,
  UserPlus, Baby, Heart, DollarSign, TrendingUp, ArrowUpRight,
} from "lucide-react";
import { funeralCoverTiers, FuneralCoverTier, members, getActiveMembers, MARKUP_MULTIPLIER } from "@/lib/businessMockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type Step = "select_tier" | "configure" | "select_members" | "review";

interface DependantConfig {
  adults: number;
  children: number;
}

export default function FuneralEnrolFlow({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("select_tier");
  const [selectedTier, setSelectedTier] = useState<FuneralCoverTier | null>(null);
  const [dependants, setDependants] = useState<DependantConfig>({ adults: 0, children: 0 });
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const eligibleMembers = getActiveMembers().filter(m => !m.insuranceProducts.includes("ins2"));

  const perMemberCost = useMemo(() => {
    if (!selectedTier) return { base: 0, mint: 0, margin: 0 };
    const base = selectedTier.basePremium + dependants.adults * selectedTier.dependantBasePremium + dependants.children * selectedTier.childBasePremium;
    const mint = selectedTier.mintPremium + dependants.adults * selectedTier.dependantMintPremium + dependants.children * selectedTier.childMintPremium;
    return { base, mint, margin: mint - base };
  }, [selectedTier, dependants]);

  const totalCost = useMemo(() => ({
    base: perMemberCost.base * selectedMembers.length,
    mint: perMemberCost.mint * selectedMembers.length,
    margin: perMemberCost.margin * selectedMembers.length,
  }), [perMemberCost, selectedMembers]);

  const marginPct = perMemberCost.base > 0 ? ((perMemberCost.margin / perMemberCost.base) * 100).toFixed(0) : "0";

  const steps: { key: Step; label: string }[] = [
    { key: "select_tier", label: "Choose Plan" },
    { key: "configure", label: "Dependants" },
    { key: "select_members", label: "Select Members" },
    { key: "review", label: "Review & Confirm" },
  ];
  const stepIndex = steps.findIndex(s => s.key === step);

  const canProceed = () => {
    if (step === "select_tier") return !!selectedTier;
    if (step === "configure") return true;
    if (step === "select_members") return selectedMembers.length > 0;
    return true;
  };

  const nextStep = () => {
    const next = steps[stepIndex + 1];
    if (next) setStep(next.key);
  };
  const prevStep = () => {
    const prev = steps[stepIndex - 1];
    if (prev) setStep(prev.key);
  };

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <div className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
              i === stepIndex && "bg-primary text-primary-foreground",
              i < stepIndex && "bg-primary/10 text-primary",
              i > stepIndex && "bg-secondary text-muted-foreground",
            )}>
              {i < stepIndex ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-4 w-4 flex items-center justify-center text-[10px]">{i + 1}</span>}
              <span>{s.label}</span>
            </div>
            {i < steps.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {/* Step 1: Select Tier */}
      {step === "select_tier" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Select Funeral Cover Plan</h2>
            <p className="text-sm text-muted-foreground">Choose a plan tier · All plans include 48-hour payout guarantee</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {funeralCoverTiers.map((tier) => {
              const isSelected = selectedTier?.id === tier.id;
              const tierMargin = tier.mintPremium - tier.basePremium;
              return (
                <Card
                  key={tier.id}
                  className={cn(
                    "cursor-pointer transition-all relative overflow-hidden",
                    isSelected ? "ring-2 ring-primary shadow-md" : "hover:shadow-md hover:border-primary/30",
                    tier.id === "fc_standard" && "border-primary/40",
                  )}
                  onClick={() => setSelectedTier(tier)}
                >
                  {tier.id === "fc_standard" && (
                    <div className="absolute top-0 right-0">
                      <Badge className="rounded-none rounded-bl-lg text-[9px] bg-primary">Most Popular</Badge>
                    </div>
                  )}
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Shield className={cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground")} />
                      {tier.label}
                    </CardTitle>
                    <p className="text-2xl font-bold tracking-tight">
                      R{tier.coverAmount.toLocaleString()}
                    </p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">cover amount</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Pricing showcase */}
                    <div className="bg-secondary/60 rounded-lg p-3 space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Cost price</span>
                        <span className="line-through text-muted-foreground">R{tier.basePremium}/pm</span>
                      </div>
                      <div className="flex justify-between text-sm font-semibold">
                        <span>Client pays</span>
                        <span>R{tier.mintPremium}/pm</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between text-sm">
                        <span className="text-xs text-muted-foreground">Your margin</span>
                        <span className="font-bold text-ticker-positive">R{tierMargin}/pm</span>
                      </div>
                      <Badge variant="outline" className="text-[9px] bg-ticker-positive/10 text-ticker-positive border-ticker-positive/20 w-full justify-center">
                        {marginPct || ((tierMargin / tier.basePremium) * 100).toFixed(0)}% margin · {MARKUP_MULTIPLIER}× markup
                      </Badge>
                    </div>

                    <div className="space-y-1.5">
                      {tier.features.map((f, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <CheckCircle2 className="h-3 w-3 text-ticker-positive mt-0.5 shrink-0" />
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>

                    <p className="text-[10px] text-muted-foreground text-center">Up to {tier.maxDependants} dependants</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 2: Configure Dependants */}
      {step === "configure" && selectedTier && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Configure Dependants</h2>
            <p className="text-sm text-muted-foreground">Add spouse/adult dependants and children per member · Max {selectedTier.maxDependants} dependants</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Adult dependants */}
            <Card>
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <Heart className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Adult Dependants</p>
                    <p className="text-xs text-muted-foreground">Spouse, parents, extended family</p>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button size="icon" variant="outline" className="h-8 w-8" disabled={dependants.adults === 0}
                      onClick={() => setDependants(d => ({ ...d, adults: d.adults - 1 }))}>
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="text-2xl font-bold w-8 text-center">{dependants.adults}</span>
                    <Button size="icon" variant="outline" className="h-8 w-8"
                      disabled={dependants.adults + dependants.children >= selectedTier.maxDependants}
                      onClick={() => setDependants(d => ({ ...d, adults: d.adults + 1 }))}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">per dependant</p>
                    <p className="text-sm font-semibold">R{selectedTier.dependantMintPremium}/pm</p>
                    <p className="text-[10px] text-ticker-positive">margin R{selectedTier.dependantMintPremium - selectedTier.dependantBasePremium}/pm</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Child dependants */}
            <Card>
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-10 w-10 rounded-lg bg-warning/10 text-warning flex items-center justify-center">
                    <Baby className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Child Dependants</p>
                    <p className="text-xs text-muted-foreground">Under 21, or under 26 if studying</p>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button size="icon" variant="outline" className="h-8 w-8" disabled={dependants.children === 0}
                      onClick={() => setDependants(d => ({ ...d, children: d.children - 1 }))}>
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="text-2xl font-bold w-8 text-center">{dependants.children}</span>
                    <Button size="icon" variant="outline" className="h-8 w-8"
                      disabled={dependants.adults + dependants.children >= selectedTier.maxDependants}
                      onClick={() => setDependants(d => ({ ...d, children: d.children + 1 }))}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">per child</p>
                    <p className="text-sm font-semibold">R{selectedTier.childMintPremium}/pm</p>
                    <p className="text-[10px] text-ticker-positive">margin R{selectedTier.childMintPremium - selectedTier.childBasePremium}/pm</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Live pricing summary */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Per-Member Cost Breakdown</p>
              <div className="grid grid-cols-4 gap-4 text-center">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Main Member</p>
                  <p className="text-sm font-semibold">R{selectedTier.mintPremium}/pm</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">{dependants.adults} Adult Dep.</p>
                  <p className="text-sm font-semibold">R{dependants.adults * selectedTier.dependantMintPremium}/pm</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">{dependants.children} Children</p>
                  <p className="text-sm font-semibold">R{dependants.children * selectedTier.childMintPremium}/pm</p>
                </div>
                <div className="border-l border-border pl-4">
                  <p className="text-[10px] text-muted-foreground uppercase">Total / Member</p>
                  <p className="text-lg font-bold">R{perMemberCost.mint}/pm</p>
                  <p className="text-[10px] text-ticker-positive font-semibold">margin R{perMemberCost.margin}/pm</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Step 3: Select Members */}
      {step === "select_members" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Select Members to Enrol</h2>
              <p className="text-sm text-muted-foreground">{eligibleMembers.length} eligible members · {selectedMembers.length} selected</p>
            </div>
            <Button variant="outline" size="sm"
              onClick={() => setSelectedMembers(selectedMembers.length === eligibleMembers.length ? [] : eligibleMembers.map(m => m.id))}>
              {selectedMembers.length === eligibleMembers.length ? "Deselect All" : "Select All"}
            </Button>
          </div>

          <Card>
            <CardContent className="p-0 divide-y divide-border">
              {eligibleMembers.map((member) => {
                const checked = selectedMembers.includes(member.id);
                return (
                  <label key={member.id} className={cn(
                    "flex items-center gap-4 px-5 py-3.5 cursor-pointer transition-colors",
                    checked ? "bg-primary/5" : "hover:bg-secondary/50",
                  )}>
                    <Checkbox checked={checked} onCheckedChange={(c) => {
                      setSelectedMembers(c ? [...selectedMembers, member.id] : selectedMembers.filter(id => id !== member.id));
                    }} />
                    <div className={cn(
                      "h-9 w-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0",
                      member.role === "employee" ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning",
                    )}>
                      {member.name.split(" ").map(n => n[0]).join("")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{member.name}</p>
                      <p className="text-xs text-muted-foreground">{member.role === "employee" ? "Employee" : "Stokvel Member"} · {member.email}</p>
                    </div>
                    {checked && (
                      <div className="text-right">
                        <p className="text-sm font-semibold">R{perMemberCost.mint}/pm</p>
                        <p className="text-[10px] text-ticker-positive">+R{perMemberCost.margin} margin</p>
                      </div>
                    )}
                  </label>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Step 4: Review */}
      {step === "review" && selectedTier && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Review & Confirm Enrolment</h2>
            <p className="text-sm text-muted-foreground">Funeral Cover · {selectedTier.label} Plan · {selectedMembers.length} members</p>
          </div>

          {/* Revenue showcase */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="bg-secondary/50">
              <CardContent className="p-4 text-center">
                <DollarSign className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Monthly Premiums</p>
                <p className="text-xl font-bold mt-1">R{totalCost.mint.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">collected from members</p>
              </CardContent>
            </Card>
            <Card className="bg-ticker-positive/5 border-ticker-positive/20">
              <CardContent className="p-4 text-center">
                <ArrowUpRight className="h-4 w-4 mx-auto text-ticker-positive mb-1" />
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Monthly Margin</p>
                <p className="text-xl font-bold text-ticker-positive mt-1">R{totalCost.margin.toLocaleString()}</p>
                <p className="text-[10px] text-ticker-positive">{marginPct}% margin</p>
              </CardContent>
            </Card>
            <Card className="bg-secondary/50">
              <CardContent className="p-4 text-center">
                <TrendingUp className="h-4 w-4 mx-auto text-primary mb-1" />
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Annual Revenue</p>
                <p className="text-xl font-bold mt-1">R{(totalCost.margin * 12).toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">projected margin</p>
              </CardContent>
            </Card>
            <Card className="bg-secondary/50">
              <CardContent className="p-4 text-center">
                <Users className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Members</p>
                <p className="text-xl font-bold mt-1">{selectedMembers.length}</p>
                <p className="text-[10px] text-muted-foreground">{1 + dependants.adults + dependants.children} lives each</p>
              </CardContent>
            </Card>
          </div>

          {/* Breakdown table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Cost Breakdown per Member</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {[
                  { label: "Main member", base: selectedTier.basePremium, mint: selectedTier.mintPremium, qty: 1 },
                  { label: "Adult dependants", base: selectedTier.dependantBasePremium, mint: selectedTier.dependantMintPremium, qty: dependants.adults },
                  { label: "Child dependants", base: selectedTier.childBasePremium, mint: selectedTier.childMintPremium, qty: dependants.children },
                ].map((row) => (
                  <div key={row.label} className="grid grid-cols-6 gap-2 text-xs items-center py-2 border-b border-border last:border-0">
                    <div className="col-span-2 font-medium">{row.label} {row.qty > 1 ? `×${row.qty}` : ""}</div>
                    <div className="text-right text-muted-foreground line-through">R{row.base * row.qty}</div>
                    <div className="text-right font-semibold">R{row.mint * row.qty}</div>
                    <div className="text-right text-ticker-positive font-semibold">+R{(row.mint - row.base) * row.qty}</div>
                    <div className="text-right">
                      <Badge variant="outline" className="text-[9px] text-ticker-positive">{row.base > 0 ? (((row.mint - row.base) / row.base) * 100).toFixed(0) : 0}%</Badge>
                    </div>
                  </div>
                ))}
                <Separator />
                <div className="grid grid-cols-6 gap-2 text-sm items-center py-2 font-bold">
                  <div className="col-span-2">Total per member</div>
                  <div className="text-right text-muted-foreground line-through text-xs">R{perMemberCost.base}</div>
                  <div className="text-right">R{perMemberCost.mint}/pm</div>
                  <div className="text-right text-ticker-positive">+R{perMemberCost.margin}</div>
                  <div className="text-right">
                    <Badge className="text-[9px] bg-ticker-positive text-primary-foreground">{marginPct}%</Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Selected members */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Enrolled Members ({selectedMembers.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border max-h-48 overflow-y-auto">
                {selectedMembers.map(id => {
                  const m = members.find(mb => mb.id === id);
                  if (!m) return null;
                  return (
                    <div key={id} className="flex items-center justify-between px-5 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-semibold">
                          {m.name.split(" ").map(n => n[0]).join("")}
                        </div>
                        <span className="text-sm font-medium">{m.name}</span>
                      </div>
                      <span className="text-sm font-semibold">R{perMemberCost.mint}/pm</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-2 border-t border-border">
        <Button variant="outline" onClick={stepIndex === 0 ? onClose : prevStep} className="gap-2">
          <ChevronLeft className="h-4 w-4" />
          {stepIndex === 0 ? "Cancel" : "Back"}
        </Button>
        <div className="flex items-center gap-3">
          {step === "review" && (
            <div className="text-right mr-4">
              <p className="text-xs text-muted-foreground">Total monthly margin</p>
              <p className="text-lg font-bold text-ticker-positive">R{totalCost.margin.toLocaleString()}/pm</p>
            </div>
          )}
          {step === "review" ? (
            <Button onClick={onClose} className="gap-2">
              <Shield className="h-4 w-4" /> Confirm Enrolment
            </Button>
          ) : (
            <Button onClick={nextStep} disabled={!canProceed()} className="gap-2">
              Continue <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
