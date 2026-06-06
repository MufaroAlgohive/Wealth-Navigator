import { fcComplianceQueue, statusColors } from "@/lib/funeralCoverData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import StatCard from "@/components/StatCard";
import { Shield, Clock, CheckCircle, AlertCircle, XCircle, FileText, AlertTriangle, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

const pending = fcComplianceQueue.filter(a => a.status === "pending");
const requiresInfo = fcComplianceQueue.filter(a => a.status === "requires_info");
const approved = fcComplianceQueue.filter(a => a.status === "approved");

const statusIcon: Record<string, React.ElementType> = {
  pending: Clock, approved: CheckCircle, rejected: XCircle, requires_info: AlertCircle,
};

export default function FCCompliance() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Compliance Review</h1>
        <p className="text-sm text-muted-foreground mt-0.5">KYC / FICA document review and application approval</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Pending Review" value={pending.length.toString()} icon={<Clock className="h-4 w-4" />} changeType="neutral" />
        <StatCard label="Requires Info" value={requiresInfo.length.toString()} icon={<AlertCircle className="h-4 w-4" />} changeType="neutral" />
        <StatCard label="Approved" value={approved.length.toString()} icon={<CheckCircle className="h-4 w-4" />} changeType="positive" />
        <StatCard label="Duplicate Alerts" value={fcComplianceQueue.filter(a => a.duplicateAlert).length.toString()} icon={<Copy className="h-4 w-4" />} changeType="negative" />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2"><Shield className="h-4 w-4 text-primary" />Application Queue</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Applicant</th>
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Group</th>
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Documents</th>
                <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Flags</th>
                <th className="text-center text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Status</th>
                <th className="text-left text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Submitted</th>
                <th className="text-right text-[10px] font-semibold uppercase tracking-wider px-5 py-3 text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {fcComplianceQueue.map(app => {
                const Icon = statusIcon[app.status];
                return (
                  <tr key={app.id} className="hover:bg-secondary/50">
                    <td className="px-5 py-3">
                      <p className="text-sm font-medium">{app.memberName}</p>
                      {app.duplicateAlert && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="h-3 w-3 text-warning" />
                          <span className="text-[10px] text-warning font-medium">Possible duplicate</span>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <p className="text-sm">{app.groupName}</p>
                      <Badge variant="outline" className="text-[10px] mt-0.5">{app.groupType}</Badge>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {app.documents.map(doc => (
                          <Badge key={doc.name} variant="secondary" className={cn("text-[10px] gap-1", statusColors[doc.status])}>
                            <FileText className="h-2.5 w-2.5" />
                            {doc.name}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center">
                      {app.riskFlags.length > 0 ? (
                        <div className="space-y-0.5">
                          {app.riskFlags.map((flag, i) => (
                            <Badge key={i} variant="secondary" className="text-[10px] bg-warning/10 text-warning block">{flag}</Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">None</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-center">
                      <Badge variant="secondary" className={cn("text-[10px] gap-1", statusColors[app.status])}>
                        <Icon className="h-3 w-3" />
                        {app.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{new Date(app.submittedDate).toLocaleDateString("en-ZA")}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {app.status === "pending" && (
                          <>
                            <Button size="sm" variant="outline" className="h-7 text-xs text-success border-success/30 hover:bg-success/10">Approve</Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10">Reject</Button>
                          </>
                        )}
                        {app.status === "requires_info" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs">Request Docs</Button>
                        )}
                        <Button variant="ghost" size="sm" className="h-7 text-xs">View</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Notes for requires_info */}
      {requiresInfo.filter(a => a.notes).map(app => (
        <Card key={app.id} className="bg-primary/5 border-primary/20">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">{app.memberName}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{app.notes}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
