import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  UserPlus, Upload, FileSpreadsheet, CheckCircle2, ChevronRight,
  Plus, Minus, Heart, Baby, Shield, User, File, X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fcGroups, groupTypeLabels, MARKUP_MULTIPLIER } from "@/lib/funeralCoverData";

type Step = "member" | "cover" | "dependants" | "documents" | "review";

interface DependantForm {
  name: string;
  relationship: "spouse" | "child" | "parent" | "extended";
  dob: string;
}

export default function FCOnboarding() {
  const [mode, setMode] = useState<"single" | "bulk" | null>(null);
  const [step, setStep] = useState<Step>("member");
  const [memberName, setMemberName] = useState("");
  const [memberID, setMemberID] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberPhone, setMemberPhone] = useState("");
  const [groupId, setGroupId] = useState("");
  const [coverType, setCoverType] = useState<string>("");
  const [coverAmount, setCoverAmount] = useState<string>("");
  const [dependants, setDependants] = useState<DependantForm[]>([]);

  const steps: { key: Step; label: string }[] = [
    { key: "member", label: "Principal Member" },
    { key: "cover", label: "Cover Type" },
    { key: "dependants", label: "Dependants" },
    { key: "documents", label: "Documents" },
    { key: "review", label: "Submit" },
  ];
  const stepIndex = steps.findIndex(s => s.key === step);

  const addDependant = () => setDependants([...dependants, { name: "", relationship: "child", dob: "" }]);
  const removeDependant = (i: number) => setDependants(dependants.filter((_, idx) => idx !== i));

  const basePricing: Record<string, number> = { "15000": 15, "30000": 25, "50000": 40 };
  const selectedBase = basePricing[coverAmount] || 0;
  const clientPremium = Math.round(selectedBase * MARKUP_MULTIPLIER);

  if (!mode) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Member Onboarding</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Add new members to funeral cover</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
          <Card className="cursor-pointer hover:shadow-md hover:border-primary/30 transition-all" onClick={() => setMode("single")}>
            <CardContent className="p-8 text-center">
              <div className="h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
                <UserPlus className="h-7 w-7" />
              </div>
              <p className="text-lg font-semibold">Single Member</p>
              <p className="text-sm text-muted-foreground mt-1">Add one member at a time with full details, dependants, and document upload</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-md hover:border-primary/30 transition-all" onClick={() => setMode("bulk")}>
            <CardContent className="p-8 text-center">
              <div className="h-14 w-14 rounded-xl bg-warning/10 text-warning flex items-center justify-center mx-auto mb-4">
                <FileSpreadsheet className="h-7 w-7" />
              </div>
              <p className="text-lg font-semibold">Bulk Upload</p>
              <p className="text-sm text-muted-foreground mt-1">Upload a CSV or Excel file to onboard multiple members at once</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (mode === "bulk") {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bulk Member Upload</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Upload a CSV or Excel file with member data</p>
          </div>
          <Button variant="ghost" onClick={() => setMode(null)}>← Back</Button>
        </div>

        <Card className="max-w-2xl">
          <CardContent className="p-6 space-y-6">
            <div className="border-2 border-dashed border-border rounded-xl p-12 text-center hover:border-primary/40 transition-colors cursor-pointer">
              <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium">Drop your file here or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">Supports .csv, .xlsx, .xls · Max 5MB</p>
            </div>

            <div className="bg-secondary/50 rounded-lg p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Required Columns</p>
              <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                <span>• Full Name</span><span>• ID Number</span>
                <span>• Date of Birth</span><span>• Phone Number</span>
                <span>• Email Address</span><span>• Cover Type</span>
                <span>• Cover Amount</span><span>• Spouse Name (optional)</span>
                <span>• Child 1 Name (optional)</span><span>• Child 1 DOB (optional)</span>
              </div>
            </div>

            <Button variant="outline" className="w-full">
              <FileSpreadsheet className="h-4 w-4 mr-2" />Download Import Template
            </Button>

            <Separator />

            <div>
              <Label className="text-xs">Assign to Group</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select group" /></SelectTrigger>
                <SelectContent>
                  {fcGroups.map(g => (
                    <SelectItem key={g.id} value={g.id}>{g.name} ({groupTypeLabels[g.type]})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button className="w-full" disabled>Upload & Process</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Add New Member</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Single member onboarding wizard</p>
        </div>
        <Button variant="ghost" onClick={() => setMode(null)}>← Back</Button>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <div className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer",
              i === stepIndex && "bg-primary text-primary-foreground",
              i < stepIndex && "bg-primary/10 text-primary",
              i > stepIndex && "bg-secondary text-muted-foreground",
            )} onClick={() => i <= stepIndex && setStep(s.key)}>
              {i < stepIndex ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-4 w-4 flex items-center justify-center text-[10px]">{i + 1}</span>}
              <span className="hidden sm:inline">{s.label}</span>
            </div>
            {i < steps.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </div>
        ))}
      </div>

      <div className="max-w-2xl">
        {/* Step 1: Member Details */}
        {step === "member" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><User className="h-4 w-4 text-primary" />Principal Member Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Assign to Group</Label>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select group" /></SelectTrigger>
                  <SelectContent>
                    {fcGroups.filter(g => g.status === "active").map(g => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label className="text-xs">Full Name</Label><Input className="mt-1.5" value={memberName} onChange={e => setMemberName(e.target.value)} placeholder="e.g. Bongani Sithole" /></div>
                <div><Label className="text-xs">SA ID Number</Label><Input className="mt-1.5" value={memberID} onChange={e => setMemberID(e.target.value)} placeholder="13 digits" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label className="text-xs">Email</Label><Input type="email" className="mt-1.5" value={memberEmail} onChange={e => setMemberEmail(e.target.value)} /></div>
                <div><Label className="text-xs">Phone</Label><Input className="mt-1.5" value={memberPhone} onChange={e => setMemberPhone(e.target.value)} placeholder="+27" /></div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Cover */}
        {step === "cover" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><Shield className="h-4 w-4 text-primary" />Select Cover</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Cover Type</Label>
                <Select value={coverType} onValueChange={setCoverType}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Single Member</SelectItem>
                    <SelectItem value="single_children">Single + Children</SelectItem>
                    <SelectItem value="family">Family Plan</SelectItem>
                    <SelectItem value="society">Society / Group</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Cover Amount</Label>
                <div className="grid grid-cols-3 gap-3 mt-2">
                  {[{ amount: "15000", label: "Basic", base: 15 }, { amount: "30000", label: "Standard", base: 25 }, { amount: "50000", label: "Premium", base: 40 }].map(opt => (
                    <div key={opt.amount} className={cn(
                      "border rounded-lg p-4 text-center cursor-pointer transition-all",
                      coverAmount === opt.amount ? "ring-2 ring-primary border-primary" : "hover:border-primary/30"
                    )} onClick={() => setCoverAmount(opt.amount)}>
                      <p className="text-xs text-muted-foreground">{opt.label}</p>
                      <p className="text-lg font-bold mt-1">R{Number(opt.amount).toLocaleString()}</p>
                      <Separator className="my-2" />
                      <p className="text-xs text-muted-foreground line-through">R{opt.base}/pm cost</p>
                      <p className="text-sm font-semibold">R{Math.round(opt.base * MARKUP_MULTIPLIER)}/pm</p>
                      <p className="text-[10px] text-success font-medium">+R{Math.round(opt.base * MARKUP_MULTIPLIER) - opt.base} margin</p>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Dependants */}
        {step === "dependants" && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2"><Heart className="h-4 w-4 text-primary" />Dependants</CardTitle>
                <Button size="sm" variant="outline" onClick={addDependant}><Plus className="h-3.5 w-3.5 mr-1" />Add Dependant</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {dependants.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  <Baby className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                  No dependants added · Click "Add Dependant" to begin
                </div>
              )}
              {dependants.map((dep, i) => (
                <div key={i} className="border rounded-lg p-4 space-y-3 relative">
                  <Button variant="ghost" size="icon" className="absolute top-2 right-2 h-6 w-6 text-muted-foreground" onClick={() => removeDependant(i)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                  <p className="text-xs font-semibold text-muted-foreground uppercase">Dependant {i + 1}</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div><Label className="text-xs">Full Name</Label><Input className="mt-1.5" value={dep.name} onChange={e => { const d = [...dependants]; d[i].name = e.target.value; setDependants(d); }} /></div>
                    <div>
                      <Label className="text-xs">Relationship</Label>
                      <Select value={dep.relationship} onValueChange={v => { const d = [...dependants]; d[i].relationship = v as DependantForm["relationship"]; setDependants(d); }}>
                        <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="spouse">Spouse</SelectItem>
                          <SelectItem value="child">Child</SelectItem>
                          <SelectItem value="parent">Parent</SelectItem>
                          <SelectItem value="extended">Extended Family</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div><Label className="text-xs">Date of Birth</Label><Input type="date" className="mt-1.5" value={dep.dob} onChange={e => { const d = [...dependants]; d[i].dob = e.target.value; setDependants(d); }} /></div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Step 4: Documents */}
        {step === "documents" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><File className="h-4 w-4 text-primary" />Upload Documents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {["SA ID / Passport", "Proof of Address", "Bank Statement"].map(doc => (
                <div key={doc} className="border rounded-lg p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <File className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{doc}</p>
                      <p className="text-xs text-muted-foreground">Required</p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm"><Upload className="h-3.5 w-3.5 mr-1" />Upload</Button>
                </div>
              ))}
              {dependants.filter(d => d.relationship === "spouse").length > 0 && (
                <div className="border rounded-lg p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3"><File className="h-4 w-4 text-muted-foreground" /><div><p className="text-sm font-medium">Marriage Certificate</p><p className="text-xs text-muted-foreground">Required for spouse</p></div></div>
                  <Button variant="outline" size="sm"><Upload className="h-3.5 w-3.5 mr-1" />Upload</Button>
                </div>
              )}
              {dependants.filter(d => d.relationship === "child").length > 0 && (
                <div className="border rounded-lg p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3"><File className="h-4 w-4 text-muted-foreground" /><div><p className="text-sm font-medium">Birth Certificate(s)</p><p className="text-xs text-muted-foreground">Required per child</p></div></div>
                  <Button variant="outline" size="sm"><Upload className="h-3.5 w-3.5 mr-1" />Upload</Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 5: Review */}
        {step === "review" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" />Review & Submit</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-secondary/50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Member</span><span className="font-medium">{memberName || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">ID Number</span><span className="font-medium">{memberID || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Group</span><span className="font-medium">{fcGroups.find(g => g.id === groupId)?.name || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Cover Type</span><span className="font-medium">{coverType || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Cover Amount</span><span className="font-medium">{coverAmount ? `R${Number(coverAmount).toLocaleString()}` : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Dependants</span><span className="font-medium">{dependants.length}</span></div>
                <Separator />
                <div className="flex justify-between"><span className="text-muted-foreground">Monthly Premium</span><span className="font-bold">R{clientPremium}/pm</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Cost Price</span><span className="text-muted-foreground">R{selectedBase}/pm</span></div>
                <div className="flex justify-between"><span className="text-success font-semibold">Margin</span><span className="text-success font-bold">R{clientPremium - selectedBase}/pm</span></div>
              </div>
              <Button className="w-full">Submit to Compliance</Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Nav Buttons */}
      <div className="flex items-center justify-between max-w-2xl">
        <Button variant="outline" disabled={stepIndex === 0} onClick={() => setStep(steps[stepIndex - 1]?.key)}>Previous</Button>
        {stepIndex < steps.length - 1 ? (
          <Button onClick={() => setStep(steps[stepIndex + 1].key)}>Continue</Button>
        ) : null}
      </div>
    </div>
  );
}
