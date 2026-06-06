import { useParams, useNavigate } from "react-router-dom";
import { fcGroups, fcMembers, fcPayments, groupTypeLabels, groupTypeColors, statusColors, formatCurrency } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Building2, Users, Heart, DollarSign, FileText, Calendar, Shield, Phone, Mail, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export default function FCGroupDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const group = fcGroups.find(g => g.id === id);
  if (!group) return <div className="text-muted-foreground">Group not found</div>;

  const groupMembers = fcMembers.filter(m => m.groupId === id);
  const groupPayments = fcPayments.filter(p => p.groupId === id);
  const costPrice = Math.round(group.monthlyPremium / 3.5);
  const margin = group.monthlyPremium - costPrice;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate("/fc/groups")} className="text-muted-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" />Back to Groups
      </Button>

      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className={cn("h-14 w-14 rounded-xl flex items-center justify-center", groupTypeColors[group.type])}>
            <Building2 className="h-7 w-7" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{group.name}</h1>
              <Badge variant="outline" className="text-[10px]">{groupTypeLabels[group.type]}</Badge>
              <Badge variant="secondary" className={cn("text-[10px]", statusColors[group.status])}>
                {group.status.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase())}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">Reg: {group.registrationNumber} · Joined {new Date(group.joinedDate).toLocaleDateString("en-ZA")}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">Edit Group</Button>
          <Button size="sm">Add Member</Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card><CardContent className="p-4 text-center"><p className="text-[10px] text-muted-foreground uppercase">Members</p><p className="text-2xl font-bold mt-1">{group.principalMembers}</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-[10px] text-muted-foreground uppercase">Covered Lives</p><p className="text-2xl font-bold mt-1">{group.coveredLives}</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-[10px] text-muted-foreground uppercase">Monthly Premium</p><p className="text-2xl font-bold mt-1">{formatCurrency(group.monthlyPremium)}</p></CardContent></Card>
        <Card className="bg-success/5 border-success/20"><CardContent className="p-4 text-center"><p className="text-[10px] text-muted-foreground uppercase">Monthly Margin</p><p className="text-2xl font-bold text-success mt-1">{formatCurrency(margin)}</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-[10px] text-muted-foreground uppercase">Collection Rate</p><p className={cn("text-2xl font-bold mt-1", group.collectionRate >= 95 ? "text-success" : group.collectionRate >= 85 ? "text-warning" : "text-destructive")}>{group.collectionRate}%</p></CardContent></Card>
      </div>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members ({groupMembers.length})</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="payments">Payment History</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          <Card>
            <CardContent className="p-0">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Member</th>
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Cover</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Dependants</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Premium</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Status</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Waiting</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Docs</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groupMembers.map(m => (
                    <tr key={m.id} className="hover:bg-secondary/50 cursor-pointer" onClick={() => navigate(`/fc/members/${m.id}`)}>
                      <td className="px-5 py-3">
                        <p className="text-sm font-medium">{m.name}</p>
                        <p className="text-xs text-muted-foreground">{m.idNumber}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant="outline" className="text-[10px]">{m.coverType.replace("_", " ")}</Badge>
                        <p className="text-[10px] text-muted-foreground mt-0.5">R{m.coverAmount.toLocaleString()}</p>
                      </td>
                      <td className="px-5 py-3 text-center text-sm">{m.dependants.length}</td>
                      <td className="px-5 py-3 text-right text-sm font-medium">R{m.premium}/pm</td>
                      <td className="px-5 py-3 text-center">
                        <Badge variant="secondary" className={cn("text-[10px]", statusColors[m.status])}>
                          {m.status.replace("_", " ")}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-center">
                        <Badge variant="secondary" className={cn("text-[10px]", statusColors[m.waitingPeriod.status])}>
                          {m.waitingPeriod.status.replace("_", " ")}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-center">
                        <span className="text-xs">{m.documents.filter(d => d.status === "verified").length}/{m.documents.length}</span>
                      </td>
                      <td className="px-5 py-3"><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /></td>
                    </tr>
                  ))}
                  {groupMembers.length === 0 && (
                    <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-muted-foreground">No members in this group yet</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contacts">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {group.contactPersons.map((cp, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <p className="text-sm font-semibold">{cp.name}</p>
                  <p className="text-xs text-muted-foreground mb-3">{cp.role}</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Mail className="h-3.5 w-3.5" />{cp.email}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />{cp.phone}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="payments">
          <Card>
            <CardContent className="p-0">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Month</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Due</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Collected</th>
                    <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Arrears</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Success Rate</th>
                    <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groupPayments.map(p => (
                    <tr key={p.id} className="hover:bg-secondary/50">
                      <td className="px-5 py-3 text-sm font-medium">{p.month}</td>
                      <td className="px-5 py-3 text-sm text-right">{formatCurrency(p.premiumDue)}</td>
                      <td className="px-5 py-3 text-sm text-right text-success font-medium">{formatCurrency(p.amountCollected)}</td>
                      <td className="px-5 py-3 text-sm text-right text-destructive">{p.arrears > 0 ? formatCurrency(p.arrears) : "—"}</td>
                      <td className="px-5 py-3 text-sm text-center">
                        <Badge variant="secondary" className={cn("text-[10px]", p.successRate >= 95 ? "bg-success/10 text-success" : p.successRate >= 85 ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")}>
                          {p.successRate}%
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-sm text-center">{p.membersOutstanding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notes">
          <Card>
            <CardContent className="p-5">
              {group.notes.length > 0 ? (
                <div className="space-y-3">
                  {group.notes.map((note, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <div className="h-1.5 w-1.5 rounded-full bg-primary mt-2 shrink-0" />
                      <p>{note}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No notes</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
