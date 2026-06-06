import { complianceItems } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shield, FileText, Clock, CheckCircle, AlertCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const statusConfig: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  pending: { icon: Clock, color: "bg-warning/10 text-warning", label: "Pending Review" },
  approved: { icon: CheckCircle, color: "bg-success/10 text-success", label: "Approved" },
  rejected: { icon: XCircle, color: "bg-destructive/10 text-destructive", label: "Rejected" },
  requires_info: { icon: AlertCircle, color: "bg-primary/10 text-primary", label: "Requires Info" },
};

export default function Compliance() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Onboarding & Compliance</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Review client submissions and manage approvals</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-warning/5 border-warning/20">
          <CardContent className="flex items-center gap-4 py-5">
            <div className="h-10 w-10 rounded-lg bg-warning/10 flex items-center justify-center">
              <Clock className="h-5 w-5 text-warning" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{complianceItems.filter(c => c.status === "pending").length}</p>
              <p className="text-xs text-muted-foreground">Pending Review</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="flex items-center gap-4 py-5">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <AlertCircle className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{complianceItems.filter(c => c.status === "requires_info").length}</p>
              <p className="text-xs text-muted-foreground">Requires Info</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-success/5 border-success/20">
          <CardContent className="flex items-center gap-4 py-5">
            <div className="h-10 w-10 rounded-lg bg-success/10 flex items-center justify-center">
              <CheckCircle className="h-5 w-5 text-success" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{complianceItems.filter(c => c.status === "approved").length}</p>
              <p className="text-xs text-muted-foreground">Approved</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            KYC Submissions
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {complianceItems.map((item) => {
              const config = statusConfig[item.status];
              const StatusIcon = config.icon;
              return (
                <div key={item.id} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center", config.color)}>
                        <StatusIcon className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{item.clientName}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.type.toUpperCase()} · {item.wealthManagerName} · Submitted {new Date(item.submittedDate).toLocaleDateString("en-ZA")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        {item.documents.map((doc) => (
                          <Badge key={doc.name} variant="secondary" className="text-[10px] gap-1">
                            <FileText className="h-2.5 w-2.5" />
                            {doc.name}
                          </Badge>
                        ))}
                      </div>
                      <Badge variant="outline" className={cn("text-[10px]", config.color)}>
                        {config.label}
                      </Badge>
                      {item.status === "pending" && (
                        <>
                          <Button size="sm" variant="outline" className="text-ticker-positive border-ticker-positive/30">Approve</Button>
                          <Button size="sm" variant="outline" className="text-destructive border-destructive/30">Reject</Button>
                        </>
                      )}
                      <Button variant="outline" size="sm">View</Button>
                    </div>
                  </div>
                  {item.notes && (
                    <p className="text-xs text-muted-foreground italic mt-2 ml-13 pl-[52px]">{item.notes}</p>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
