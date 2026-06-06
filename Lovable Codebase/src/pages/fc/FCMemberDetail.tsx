import { useParams, useNavigate } from "react-router-dom";
import { fcMembers, fcGroups, statusColors, formatCurrency } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, User, Heart, Baby, Users as UsersIcon, Shield, FileText, Calendar, CheckCircle, XCircle, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const docStatusIcon: Record<string, React.ElementType> = {
  verified: CheckCircle, uploaded: Clock, rejected: XCircle, missing: AlertCircle,
};

export default function FCMemberDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const member = fcMembers.find(m => m.id === id);
  if (!member) return <div className="text-muted-foreground">Member not found</div>;
  const group = fcGroups.find(g => g.id === member.groupId);
  const docsComplete = member.documents.filter(d => d.status === "verified").length;
  const docsTotal = member.documents.length;
  const margin = member.premium - member.costPrice;

  const relIcon: Record<string, React.ElementType> = { spouse: Heart, child: Baby, parent: UsersIcon, extended: UsersIcon };

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="text-muted-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" />Back
      </Button>

      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center text-lg font-bold">
            {member.name.split(" ").map(n => n[0]).join("")}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{member.name}</h1>
              <Badge variant="secondary" className={cn("text-[10px]", statusColors[member.status])}>
                {member.status.replace("_", " ")}
              </Badge>
              <Badge variant="secondary" className={cn("text-[10px]", statusColors[member.policyStatus])}>
                {member.policyStatus.replace("_", " ")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              ID: {member.idNumber} · Age {member.age} · {group?.name}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">Edit</Button>
          <Button variant="outline" size="sm" className="text-destructive border-destructive/30">Remove</Button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-[10px] text-muted-foreground uppercase">Cover Type</p>
          <p className="text-sm font-semibold mt-1">{member.coverType.replace("_", " ")}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-[10px] text-muted-foreground uppercase">Cover Amount</p>
          <p className="text-sm font-semibold mt-1">R{member.coverAmount.toLocaleString()}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-[10px] text-muted-foreground uppercase">Monthly Premium</p>
          <p className="text-sm font-semibold mt-1">R{member.premium}/pm</p>
        </CardContent></Card>
        <Card className="bg-success/5 border-success/20"><CardContent className="p-4">
          <p className="text-[10px] text-muted-foreground uppercase">Margin</p>
          <p className="text-sm font-semibold text-success mt-1">R{margin}/pm</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-[10px] text-muted-foreground uppercase">Dependants</p>
          <p className="text-sm font-semibold mt-1">{member.dependants.length}</p>
        </CardContent></Card>
      </div>

      <Tabs defaultValue="dependants">
        <TabsList>
          <TabsTrigger value="dependants">Family ({member.dependants.length})</TabsTrigger>
          <TabsTrigger value="documents">Documents ({docsComplete}/{docsTotal})</TabsTrigger>
          <TabsTrigger value="policy">Policy Details</TabsTrigger>
        </TabsList>

        <TabsContent value="dependants">
          <div className="space-y-3">
            {/* Principal */}
            <Card className="border-primary/20">
              <CardContent className="p-5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <User className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{member.name} <span className="text-xs text-muted-foreground font-normal">· Principal Member</span></p>
                    <p className="text-xs text-muted-foreground">DOB: {member.dob} · Age: {member.age}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-semibold">R{member.coverAmount.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">cover</p>
                  </div>
                  <Badge variant="secondary" className={cn("text-[10px]", statusColors[member.waitingPeriod.status])}>
                    {member.waitingPeriod.status === "completed" ? "Active" : member.waitingPeriod.status === "in_progress" ? `Waiting until ${member.waitingPeriod.endsDate}` : "Not Started"}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Dependants */}
            {member.dependants.map(dep => {
              const DepIcon = relIcon[dep.relationship] || UsersIcon;
              const depDocsOk = dep.documents.filter(d => d.status === "verified").length;
              return (
                <Card key={dep.id}>
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center",
                          dep.relationship === "spouse" ? "bg-destructive/10 text-destructive" :
                          dep.relationship === "child" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"
                        )}>
                          <DepIcon className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{dep.name} <span className="text-xs text-muted-foreground font-normal">· {dep.relationship}</span></p>
                          <p className="text-xs text-muted-foreground">DOB: {dep.dob} · Age: {dep.age}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-sm font-semibold">R{dep.coverAmount.toLocaleString()}</p>
                          <p className="text-[10px] text-muted-foreground">cover</p>
                        </div>
                        <Badge variant="secondary" className={cn("text-[10px]", statusColors[dep.waitingPeriod.status])}>
                          {dep.waitingPeriod.status === "completed" ? "Active" : "Waiting"}
                        </Badge>
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground">Docs: {depDocsOk}/{dep.documents.length}</p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {member.dependants.length === 0 && (
              <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No dependants added</CardContent></Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="documents">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Document Checklist</CardTitle>
                <p className="text-xs text-muted-foreground">{docsComplete}/{docsTotal} verified</p>
              </div>
              <Progress value={(docsComplete / docsTotal) * 100} className="h-1.5 mt-2" />
            </CardHeader>
            <CardContent className="p-0 divide-y divide-border">
              {member.documents.map((doc, i) => {
                const DocIcon = docStatusIcon[doc.status];
                return (
                  <div key={i} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm">{doc.name}</p>
                    </div>
                    <Badge variant="secondary" className={cn("text-[10px] gap-1", statusColors[doc.status])}>
                      <DocIcon className="h-3 w-3" />
                      {doc.status}
                    </Badge>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="policy">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><p className="text-[10px] text-muted-foreground uppercase">Payment Method</p><p className="text-sm font-medium mt-1">{member.paymentMethod.replace("_", " ")}</p></div>
                <div><p className="text-[10px] text-muted-foreground uppercase">Last Payment</p><p className="text-sm font-medium mt-1">{member.lastPaymentDate || "N/A"}</p></div>
                <div><p className="text-[10px] text-muted-foreground uppercase">Arrears</p><p className={cn("text-sm font-medium mt-1", member.arrears > 0 ? "text-destructive" : "text-success")}>{member.arrears > 0 ? `R${member.arrears}` : "None"}</p></div>
                <div><p className="text-[10px] text-muted-foreground uppercase">Joined</p><p className="text-sm font-medium mt-1">{new Date(member.joinedDate).toLocaleDateString("en-ZA")}</p></div>
                <div><p className="text-[10px] text-muted-foreground uppercase">Cost Price</p><p className="text-sm font-medium mt-1">R{member.costPrice}/pm</p></div>
                <div><p className="text-[10px] text-muted-foreground uppercase">Client Premium</p><p className="text-sm font-medium mt-1">R{member.premium}/pm</p></div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
