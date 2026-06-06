import { fcClaims, statusColors, formatCurrency } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import StatCard from "@/components/StatCard";
import { FileText, Clock, CheckCircle, AlertCircle, DollarSign, Timer } from "lucide-react";
import { cn } from "@/lib/utils";

const stageColors: Record<string, string> = {
  submitted: "bg-primary/10 text-primary",
  documents_pending: "bg-warning/10 text-warning",
  under_review: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  paid: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
};

const totalValue = fcClaims.reduce((s, c) => s + c.amount, 0);
const paidClaims = fcClaims.filter(c => c.stage === "paid");
const avgTurnaround = fcClaims.length ? (fcClaims.reduce((s, c) => s + c.turnaroundDays, 0) / fcClaims.length).toFixed(1) : "0";

export default function FCClaims() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Claims</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Track claim submissions, reviews, and payouts</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Claims" value={fcClaims.length.toString()} icon={<FileText className="h-4 w-4" />} />
        <StatCard label="Total Value" value={formatCurrency(totalValue)} icon={<DollarSign className="h-4 w-4" />} />
        <StatCard label="Paid Out" value={paidClaims.length.toString()} subtitle={formatCurrency(paidClaims.reduce((s, c) => s + c.amount, 0))} icon={<CheckCircle className="h-4 w-4" />} changeType="positive" />
        <StatCard label="Avg Turnaround" value={`${avgTurnaround} days`} icon={<Timer className="h-4 w-4" />} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">All Claims</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Claim</th>
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Member</th>
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Group</th>
                <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Amount</th>
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Documents</th>
                <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Stage</th>
                <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Payout</th>
                <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Days</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {fcClaims.map(claim => (
                <tr key={claim.id} className="hover:bg-secondary/50">
                  <td className="px-5 py-3">
                    <p className="text-sm font-medium capitalize">{claim.claimType}</p>
                    <p className="text-[10px] text-muted-foreground">{new Date(claim.submittedDate).toLocaleDateString("en-ZA")}</p>
                  </td>
                  <td className="px-5 py-3 text-sm">{claim.memberName}</td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{claim.groupName}</td>
                  <td className="px-5 py-3 text-sm text-right font-medium">{formatCurrency(claim.amount)}</td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {claim.requiredDocuments.map(doc => (
                        <Badge key={doc.name} variant="secondary" className={cn("text-[10px] gap-0.5", statusColors[doc.status])}>
                          <FileText className="h-2.5 w-2.5" />
                          {doc.name.length > 15 ? doc.name.slice(0, 15) + "…" : doc.name}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <Badge variant="secondary" className={cn("text-[10px]", stageColors[claim.stage])}>
                      {claim.stage.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <Badge variant="secondary" className={cn("text-[10px]",
                      claim.payoutStatus === "paid" ? "bg-success/10 text-success" :
                      claim.payoutStatus === "processing" ? "bg-warning/10 text-warning" :
                      claim.payoutStatus === "declined" ? "bg-destructive/10 text-destructive" :
                      "bg-muted text-muted-foreground"
                    )}>
                      {claim.payoutStatus}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-sm text-center text-muted-foreground">{claim.turnaroundDays}d</td>
                  <td className="px-5 py-3"><Button variant="ghost" size="sm" className="h-7 text-xs">View</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Notes */}
      {fcClaims.filter(c => c.notes).map(c => (
        <Card key={c.id} className="bg-warning/5 border-warning/20">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">{c.memberName} — {c.claimType}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{c.notes}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
