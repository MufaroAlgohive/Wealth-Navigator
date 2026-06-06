import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Filter, ArrowUpRight, ArrowDownRight, Upload, X, Send } from "lucide-react";
import { clients, formatCurrency, formatPct, type Client } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const statusColors: Record<string, string> = {
  active: "bg-success/10 text-success",
  pending_kyc: "bg-warning/10 text-warning",
  onboarding: "bg-primary/10 text-primary",
  suspended: "bg-destructive/10 text-destructive",
};

const statusLabels: Record<string, string> = {
  active: "Active",
  pending_kyc: "Pending KYC",
  onboarding: "Onboarding",
  suspended: "Suspended",
};

export default function Clients() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showOnboard, setShowOnboard] = useState(false);
  const [uploadedDocs, setUploadedDocs] = useState<string[]>([]);

  const filtered = clients.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase()) || c.email.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleAddDoc = () => {
    const docNames = ["ID Document", "Proof of Address", "Source of Funds", "Tax Certificate", "Bank Statement"];
    const next = docNames.find((d) => !uploadedDocs.includes(d));
    if (next) setUploadedDocs([...uploadedDocs, next]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your client relationships and allocations</p>
        </div>
        <Button onClick={() => { setShowOnboard(true); setUploadedDocs([]); }} className="gap-2">
          <Plus className="h-4 w-4" />
          Onboard Client
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search clients..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <Filter className="h-3.5 w-3.5 mr-2" />
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="pending_kyc">Pending KYC</SelectItem>
            <SelectItem value="onboarding">Onboarding</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Client List */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Client</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">AUM</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Cash Balance</th>
                  <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Strategies</th>
                  <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Tier</th>
                  <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Status</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-6 py-3">Return</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((client) => {
                  const totalReturn = client.strategies.length > 0
                    ? client.strategies.reduce((sum, s) => sum + (s.currentValue - s.allocated), 0)
                    : 0;
                  const totalReturnPct = client.strategies.length > 0
                    ? (totalReturn / client.strategies.reduce((s, c) => s + c.allocated, 0)) * 100
                    : 0;

                  return (
                    <tr key={client.id} className="hover:bg-secondary/50 transition-colors cursor-pointer">
                      <td className="px-6 py-4">
                        <Link to={`/clients/${client.id}`} className="block">
                          <p className="text-sm font-medium">{client.name}</p>
                          <p className="text-xs text-muted-foreground">{client.email}</p>
                        </Link>
                      </td>
                      <td className="text-right px-6 py-4 text-sm font-medium">{client.aum > 0 ? formatCurrency(client.aum) : "—"}</td>
                      <td className="text-right px-6 py-4 text-sm">{client.cashBalance > 0 ? formatCurrency(client.cashBalance) : "—"}</td>
                      <td className="text-center px-6 py-4 text-sm">{client.strategies.length}</td>
                      <td className="text-center px-6 py-4">
                        <Badge variant="outline" className="text-[10px]">{client.tier}</Badge>
                      </td>
                      <td className="text-center px-6 py-4">
                        <Badge variant="secondary" className={cn("text-[10px]", statusColors[client.status])}>
                          {statusLabels[client.status]}
                        </Badge>
                      </td>
                      <td className="text-right px-6 py-4">
                        {client.strategies.length > 0 ? (
                          <span className={cn("text-sm font-medium flex items-center justify-end gap-1", totalReturnPct >= 0 ? "text-ticker-positive" : "text-ticker-negative")}>
                            {totalReturnPct >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                            {formatPct(totalReturnPct)}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Onboard Dialog */}
      <Dialog open={showOnboard} onOpenChange={setShowOnboard}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Onboard New Client</DialogTitle>
            <DialogDescription>Enter client details and upload required documents for KYC review.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-4">
              <div><Label className="text-xs">First Name</Label><Input placeholder="First name" className="mt-1" /></div>
              <div><Label className="text-xs">Last Name</Label><Input placeholder="Last name" className="mt-1" /></div>
            </div>
            <div><Label className="text-xs">Email</Label><Input placeholder="client@email.com" type="email" className="mt-1" /></div>
            <div><Label className="text-xs">Phone</Label><Input placeholder="+27 ..." className="mt-1" /></div>
            <div><Label className="text-xs">Expected AUM</Label><Input placeholder="e.g. 50,000,000" className="mt-1" /></div>

            {/* Document upload area */}
            <div>
              <Label className="text-xs">KYC Documents</Label>
              <div className="mt-1 border-2 border-dashed border-border rounded-lg p-4 text-center">
                <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
                <p className="text-xs text-muted-foreground">ID Document, Proof of Address, Source of Funds</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={handleAddDoc}>
                  Upload Document
                </Button>
              </div>
              {uploadedDocs.length > 0 && (
                <div className="mt-2 space-y-1">
                  {uploadedDocs.map((doc) => (
                    <div key={doc} className="flex items-center justify-between bg-secondary rounded-md px-3 py-1.5">
                      <span className="text-xs font-medium">{doc}</span>
                      <button onClick={() => setUploadedDocs(uploadedDocs.filter((d) => d !== doc))} className="text-muted-foreground hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowOnboard(false)}>Cancel</Button>
              <Button className="flex-1 gap-2">
                <Send className="h-4 w-4" />
                Submit to Compliance
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
