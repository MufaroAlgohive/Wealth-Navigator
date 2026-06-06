import { complianceItems, clients, formatCurrency } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shield, FileText, Clock, CheckCircle, AlertCircle, Users, UserCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import StatCard from "@/components/StatCard";

const statusConfig: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  pending: { icon: Clock, color: "bg-warning/10 text-warning", label: "Pending Review" },
  approved: { icon: CheckCircle, color: "bg-success/10 text-success", label: "Approved" },
  rejected: { icon: XCircle, color: "bg-destructive/10 text-destructive", label: "Rejected" },
  requires_info: { icon: AlertCircle, color: "bg-primary/10 text-primary", label: "Requires Info" },
};

const docStatusColor: Record<string, string> = {
  uploaded: "bg-warning/10 text-warning",
  verified: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
};

const pendingCount = complianceItems.filter(c => c.status === "pending").length;
const requiresInfoCount = complianceItems.filter(c => c.status === "requires_info").length;
const approvedCount = complianceItems.filter(c => c.status === "approved").length;
const rejectedCount = complianceItems.filter(c => c.status === "rejected").length;

export default function AdminDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Onboarding pipeline and compliance overview</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Pending Review" value={pendingCount.toString()} icon={<Clock className="h-4 w-4" />} changeType="neutral" />
        <StatCard label="Requires Info" value={requiresInfoCount.toString()} icon={<AlertCircle className="h-4 w-4" />} changeType="neutral" />
        <StatCard label="Approved" value={approvedCount.toString()} icon={<CheckCircle className="h-4 w-4" />} changeType="positive" />
        <StatCard label="Total Clients" value={clients.length.toString()} subtitle={`${clients.filter(c => c.status === 'active').length} active`} icon={<Users className="h-4 w-4" />} />
      </div>

      {/* Pipeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Onboarding Pipeline
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Client</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Wealth Manager</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Type</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Documents</th>
                <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Status</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Submitted</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {complianceItems.map((item) => {
                const config = statusConfig[item.status];
                const StatusIcon = config.icon;
                return (
                  <tr key={item.id} className="hover:bg-secondary/50">
                    <td className="px-6 py-3">
                      <p className="text-sm font-medium">{item.clientName}</p>
                    </td>
                    <td className="px-6 py-3 text-sm text-muted-foreground">{item.wealthManagerName}</td>
                    <td className="px-6 py-3">
                      <Badge variant="outline" className="text-[10px] uppercase">{item.type}</Badge>
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        {item.documents.map((doc) => (
                          <Badge key={doc.name} variant="secondary" className={cn("text-[10px] gap-1", docStatusColor[doc.status])}>
                            <FileText className="h-2.5 w-2.5" />
                            {doc.name}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-center">
                      <Badge variant="outline" className={cn("text-[10px]", config.color)}>
                        <StatusIcon className="h-3 w-3 mr-1" />
                        {config.label}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-xs text-muted-foreground">
                      {new Date(item.submittedDate).toLocaleDateString("en-ZA")}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {item.status === "pending" && (
                          <>
                            <Button size="sm" variant="outline" className="h-7 text-xs text-ticker-positive border-ticker-positive/30 hover:bg-ticker-positive/10">
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10">
                              Reject
                            </Button>
                          </>
                        )}
                        {item.status === "requires_info" && (
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

    </div>
  );
}
