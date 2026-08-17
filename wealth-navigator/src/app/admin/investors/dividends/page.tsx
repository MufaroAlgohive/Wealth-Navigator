"use client";

import React, { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  Upload,
  X,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

import { PageCanvas, GlassSection, GlassKpi } from "@/components/oems/primitives/glass";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/* ── helpers ──────────────────────────────────────────────────────────── */
const ZAR = (n: number | string) =>
  new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-ZA") : "—";

export default function DividendsPage() {
  const [stats, setStats] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [loadingStats, setLoadingStats] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);

  const [activeRun, setActiveRun] = useState<any>(null);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [emailPreview, setEmailPreview] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"results" | "email">("results");
  const [testEmail, setTestEmail] = useState("");
  const [selectedUserCode, setSelectedUserCode] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const res = await fetch("/api/admin/dividends/runs");
      const data = await res.json();
      if (data.ok) {
        setStats(data.stats);
        setRuns(data.runs || []);
      } else {
        toast.error(data.error || "Failed to load dividends data");
      }
    } catch {
      toast.error("Could not reach dividends API");
    } finally {
      setLoadingStats(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setFile(e.target.files[0]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.[0]) setFile(e.dataTransfer.files[0]);
  };

  const extractData = async () => {
    if (!file) return toast.error("Please select an Excel file first.");
    setIsExtracting(true);
    const fd = new FormData();
    fd.append("password", password);
    fd.append("date", paymentDate);
    fd.append("file", file);
    try {
      const res = await fetch("/api/admin/dividends/extract", { method: "POST", body: fd });
      const data = await res.json();
      if (data.ok) {
        toast.success(`Parsed successfully — ${data.records} records found.`);
        loadStats();
      } else {
        toast.error(data.error || "Extraction failed");
        loadStats();
      }
    } catch {
      toast.error("Network error");
    } finally {
      setIsExtracting(false);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const loadRun = async (run: any) => {
    setActiveRun(run);
    setActiveTab("results");
    setPayouts([]);
    setEmailPreview(null);
    setSelectedUserCode(null);

    try {
      const r = await fetch(`/api/admin/dividends/payouts?run_id=${run.id}`);
      const d = await r.json();
      if (d.ok) setPayouts(d.payouts);
    } catch {
      toast.error("Failed to load payouts");
    }

    try {
      const r2 = await fetch(`/api/admin/dividends/email?run_id=${run.id}`);
      const d2 = await r2.json();
      if (d2.ok) {
        setEmailPreview(d2);
        setSelectedUserCode(d2.previewCode ?? null);
      }
    } catch {
      toast.error("Failed to load email preview");
    }
  };

  const loadEmailForUser = async (clientCode: string) => {
    if (!activeRun) return;
    setSelectedUserCode(clientCode);
    try {
      const r = await fetch(`/api/admin/dividends/email?run_id=${activeRun.id}&client_code=${clientCode}`);
      const d = await r.json();
      if (d.ok) setEmailPreview(d);
    } catch {
      toast.error("Failed to load user email");
    }
  };

  const sendTestEmail = async () => {
    if (!testEmail || !activeRun) return toast.error("Test email and active run required.");
    try {
      const res = await fetch("/api/admin/dividends/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRun.id, testEmail }),
      });
      const data = await res.json();
      if (data.ok) toast.success("Test email sent!");
      else toast.error(data.error || "Failed to send test email");
    } catch {
      toast.error("Network error");
    }
  };

  const sendEmailToUser = async (clientCode: string) => {
    if (!activeRun) return;
    try {
      const res = await fetch("/api/admin/dividends/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRun.id, client_code: clientCode }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("Email sent successfully!");
        loadEmailForUser(clientCode);
      } else {
        toast.error(data.error || "Failed to send email");
      }
    } catch {
      toast.error("Network error");
    }
  };

  const sendAllEmails = async () => {
    if (!activeRun) return;
    if (!confirm("Are you sure you want to send all pending emails?")) return;
    try {
      const res = await fetch("/api/admin/dividends/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRun.id, sendAll: true }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(`Sent ${data.sent} emails. Failed: ${data.failed}.`);
        loadRun(activeRun);
      } else {
        toast.error(data.error || "Failed to send all emails");
      }
    } catch {
      toast.error("Network error");
    }
  };

  return (
    <PageCanvas>
      {/* ── KPI strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GlassKpi
          label="Total Runs"
          value={loadingStats ? "…" : (stats?.total_runs ?? "0")}
        />
        <GlassKpi
          label="Records Processed"
          value={loadingStats ? "…" : (stats?.total_records ?? "0")}
        />
        <GlassKpi
          label="Total Net Cash"
          value={loadingStats ? "…" : (stats?.total_net_cash ? ZAR(stats.total_net_cash) : "R 0")}
        />
        <GlassKpi
          label="Last Run"
          value={loadingStats ? "…" : fmtDate(stats?.last_run_at ?? null)}
          sub={
            stats?.last_run_at
              ? new Date(stats.last_run_at).toLocaleTimeString("en-ZA", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : undefined
          }
        />
      </div>

      {/* ── Main layout ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">

        {/* Left panel */}
        <div className="space-y-4">

          {/* Upload card */}
          <GlassSection title="Secure Ingestion" dataSource="supabase">
            {/* Drop zone */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => !file && fileInputRef.current?.click()}
              className={cn(
                "mb-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 transition-colors",
                file
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-muted/30 hover:border-primary/50 hover:bg-primary/5"
              )}
            >
              {file ? (
                <div className="flex w-full items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-500" />
                  <span className="flex-1 truncate text-sm font-medium text-foreground">
                    {file.name}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="mb-2 h-7 w-7 text-muted-foreground" />
                  <p className="text-center text-sm text-muted-foreground">
                    Drop Excel file here or{" "}
                    <span className="font-semibold text-primary">browse</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">.xlsx files only</p>
                </>
              )}
              <input
                type="file"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".xlsx,.xls"
              />
            </div>

            {/* Fields */}
            <div className="mb-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                  Effective Payment Date
                </label>
                <Input
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                  Computershare Password
                </label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <Button
              className="w-full"
              onClick={extractData}
              disabled={isExtracting || !file}
            >
              {isExtracting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Extracting…</>
              ) : (
                "Extract Data"
              )}
            </Button>
          </GlassSection>

          {/* Recent activity */}
          <GlassSection title="Recent Activity" dataSource="supabase">
            {loadingStats ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : runs.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No extraction runs yet.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {runs.map((r, i) => {
                  const ok = r.status === "success";
                  return (
                    <div
                      key={i}
                      onClick={() => ok && loadRun(r)}
                      className={cn(
                        "flex gap-3 py-3",
                        ok && "cursor-pointer rounded-lg px-2 transition-colors hover:bg-accent/50",
                        activeRun?.id === r.id && "bg-accent/50"
                      )}
                    >
                      <div
                        className={cn(
                          "mt-1.5 h-2 w-2 flex-shrink-0 rounded-full",
                          ok ? "bg-green-500" : "bg-destructive"
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {r.file_name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {ok
                            ? `${r.records} records · ${ZAR(r.total_net_cash)}`
                            : r.error_message || "Error"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </GlassSection>
        </div>

        {/* Right panel */}
        <div>
          {!activeRun ? (
            <GlassSection title="Extraction Results" dataSource="supabase">
              <div className="flex min-h-[400px] flex-col items-center justify-center text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold text-foreground">No run selected</p>
                <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">
                  Upload an Excel file and click Extract Data, or select a run from Recent Activity.
                </p>
              </div>
            </GlassSection>
          ) : (
            <GlassSection
              title={`Extraction: ${activeRun.file_name}`}
              subtitle={`Payment date: ${fmtDate(activeRun.payment_date)}`}
              dataSource="supabase"
            >
              {/* Tab bar */}
              <div className="mb-5 flex gap-5 border-b border-border">
                {(["results", "email"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "pb-2 text-sm font-semibold capitalize transition-colors border-b-2",
                      activeTab === tab
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {tab === "email" ? "Email Preview" : "Results"}
                  </button>
                ))}
              </div>

              {/* Results tab */}
              {activeTab === "results" && (
                <div>
                  <div className="mb-5 grid grid-cols-3 gap-3">
                    <GlassKpi label="Holdings" value={String(activeRun.records ?? 0)} />
                    <GlassKpi label="Net Cash" value={ZAR(activeRun.total_net_cash)} />
                    <GlassKpi
                      label="Unmatched"
                      value={String(activeRun.unmatched_count ?? 0)}
                    />
                  </div>

                  {payouts.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading payouts…
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-muted/50 text-muted-foreground">
                          <tr>
                            {payouts[0]?.raw_row &&
                              Object.keys(payouts[0].raw_row)
                                .slice(0, 6)
                                .map((k) => (
                                  <th key={k} className="border-b border-border p-3 font-semibold uppercase tracking-wider">
                                    {k}
                                  </th>
                                ))}
                            {payouts[0]?.raw_row &&
                              Object.keys(payouts[0].raw_row).length > 6 && (
                                <th className="border-b border-border p-3 font-semibold">+ more</th>
                              )}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border text-foreground">
                          {payouts.slice(0, 100).map((p, idx) => (
                            <tr key={idx} className="hover:bg-accent/30">
                              {Object.keys(p.raw_row)
                                .slice(0, 6)
                                .map((k) => (
                                  <td key={k} className="max-w-[150px] truncate p-3">
                                    {p.raw_row[k]}
                                  </td>
                                ))}
                              {Object.keys(p.raw_row).length > 6 && (
                                <td className="p-3 text-muted-foreground">…</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Email tab */}
              {activeTab === "email" && (
                <div>
                  {/* Actions bar */}
                  <div className="mb-5 flex items-end gap-3 rounded-xl border border-border bg-muted/30 p-4">
                    <div className="flex-1">
                      <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                        Test Email Address
                      </label>
                      <Input
                        type="email"
                        value={testEmail}
                        onChange={(e) => setTestEmail(e.target.value)}
                        placeholder="you@example.com"
                      />
                    </div>
                    <Button variant="outline" onClick={sendTestEmail}>
                      Send Test
                    </Button>
                    <Button onClick={sendAllEmails}>
                      Send All
                    </Button>
                  </div>

                  {/* Client list + preview pane */}
                  <div className="flex h-[600px] gap-4">
                    {/* Sidebar */}
                    <div className="w-[260px] overflow-y-auto rounded-xl border border-border bg-card">
                      {!emailPreview ? (
                        <div className="flex h-full items-center justify-center">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : (
                        <div className="divide-y divide-border">
                          {emailPreview.allClients?.map((c: any) => (
                            <div
                              key={c.client_code}
                              onClick={() => loadEmailForUser(c.client_code)}
                              className={cn(
                                "flex cursor-pointer items-center justify-between px-3 py-3 transition-colors hover:bg-accent/50",
                                selectedUserCode === c.client_code && "bg-primary/10"
                              )}
                            >
                                <div>
                                  <div className="text-sm font-semibold text-foreground">
                                    {c.first_name}
                                  </div>
                                  <div className="text-xs text-muted-foreground">{c.client_code}</div>
                                  {c.is_child && c.parent_name && (
                                    <div className="mt-0.5 text-[10px] text-foreground opacity-80">
                                      Managed by {c.parent_name}
                                    </div>
                                  )}
                                </div>
                              {c.has_sent && (
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Preview pane */}
                    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
                      {emailPreview && selectedUserCode ? (
                        <>
                          <div className="flex items-center justify-between border-b border-border bg-muted/30 p-3">
                            <span className="text-sm font-medium text-foreground">
                              Subject: {emailPreview.subject}
                            </span>
                            {emailPreview.allClients?.find(
                              (c: any) => c.client_code === selectedUserCode
                            )?.has_sent ? (
                              <Button variant="outline" size="sm" disabled>
                                <CheckCircle2 className="mr-1.5 h-3 w-3" /> Sent
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => sendEmailToUser(selectedUserCode)}
                              >
                                Send to User
                              </Button>
                            )}
                          </div>
                          <iframe
                            srcDoc={emailPreview.html}
                            className="flex-1 w-full bg-white"
                          />
                        </>
                      ) : (
                        <div className="flex flex-1 items-center justify-center">
                          <div className="flex flex-col items-center gap-2 text-muted-foreground">
                            <AlertCircle className="h-5 w-5" />
                            <span className="text-xs">Select a client to preview</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </GlassSection>
          )}
        </div>
      </div>
    </PageCanvas>
  );
}
