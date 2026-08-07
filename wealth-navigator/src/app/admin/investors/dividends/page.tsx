"use client";

import React, { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Upload, X, Eye, EyeOff, Loader2, CheckCircle2, XCircle } from "lucide-react";

export default function DividendsPage() {
  const [stats, setStats] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  
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
    try {
      const res = await fetch("/api/admin/dividends/runs");
      const data = await res.json();
      if (data.ok) {
        setStats(data.stats);
        setRuns(data.runs);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  const extractData = async () => {
    if (!file) {
      toast.error("Please select an Excel file first.");
      return;
    }
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
        // The result will be loaded by clicking on the run in the activity log
      } else {
        toast.error(data.error || "Extraction failed");
        loadStats();
      }
    } catch (err) {
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
      if (d.ok) {
        setPayouts(d.payouts);
      }
    } catch (err) {
      toast.error("Failed to load payouts");
    }

    try {
      const r2 = await fetch(`/api/admin/dividends/email?run_id=${run.id}`);
      const d2 = await r2.json();
      if (d2.ok) {
        setEmailPreview(d2);
        setSelectedUserCode(d2.previewCode);
      }
    } catch (err) {
      toast.error("Failed to load email preview");
    }
  };

  const loadEmailForUser = async (clientCode: string) => {
    if (!activeRun) return;
    setSelectedUserCode(clientCode);
    try {
      const r = await fetch(`/api/admin/dividends/email?run_id=${activeRun.id}&client_code=${clientCode}`);
      const d = await r.json();
      if (d.ok) {
        setEmailPreview(d);
      }
    } catch (err) {
      toast.error("Failed to load user email");
    }
  };

  const sendTestEmail = async () => {
    if (!testEmail || !activeRun) return toast.error("Test email and active run required.");
    try {
      const res = await fetch("/api/admin/dividends/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRun.id, testEmail })
      });
      const data = await res.json();
      if (data.ok) toast.success("Test email sent!");
      else toast.error(data.error || "Failed to send test email");
    } catch (err) {
      toast.error("Network error");
    }
  };

  const sendEmailToUser = async (clientCode: string) => {
    if (!activeRun) return;
    try {
      const res = await fetch("/api/admin/dividends/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRun.id, client_code: clientCode })
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("Email sent successfully!");
        loadEmailForUser(clientCode); // Reload to update status
      } else {
        toast.error(data.error || "Failed to send email");
      }
    } catch (err) {
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
        body: JSON.stringify({ run_id: activeRun.id, sendAll: true })
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(`Successfully sent ${data.sent} emails. Failed: ${data.failed}.`);
        loadRun(activeRun); // Reload everything
      } else {
        toast.error(data.error || "Failed to send all emails");
      }
    } catch (err) {
      toast.error("Network error");
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6 bg-slate-50 min-h-screen text-slate-900 font-sans">
      
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <span className="text-purple-600 bg-purple-100 p-2 rounded-lg">
              <Upload className="w-5 h-5" />
            </span>
            Dividends
          </h1>
          <p className="text-sm text-slate-500 mt-1">Dividend data acquisition, processing & client payout reporting hub.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Runs", val: stats?.total_runs || "—", color: "text-purple-600" },
          { label: "Records Processed", val: stats?.total_records || "—", color: "text-slate-900" },
          { label: "Total Net Cash", val: stats?.total_net_cash ? `R ${Number(stats.total_net_cash).toLocaleString('en-ZA')}` : "—", color: "text-emerald-600" },
          { label: "Last Run", val: stats?.last_run_at ? new Date(stats.last_run_at).toLocaleDateString() : "—", color: "text-slate-900", sub: stats?.last_run_at ? new Date(stats.last_run_at).toLocaleTimeString() : "" },
        ].map((s, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">{s.label}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.val}</div>
            {s.sub && <div className="text-xs text-slate-400 mt-1">{s.sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6 items-start">
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-[10px] font-bold text-purple-600 uppercase tracking-widest mb-4">Secure Ingestion</h2>
            
            <div 
              onDragOver={(e) => e.preventDefault()} 
              onDrop={handleDrop}
              onClick={() => !file && fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 mb-4 flex flex-col items-center justify-center transition-colors ${file ? 'border-purple-300 bg-purple-50' : 'border-purple-200 bg-slate-50 hover:bg-purple-50 hover:border-purple-400 cursor-pointer'}`}
            >
              {file ? (
                <div className="flex items-center gap-2 w-full">
                  <CheckCircle2 className="text-emerald-500 w-5 h-5 flex-shrink-0" />
                  <span className="text-sm font-semibold truncate flex-1">{file.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); setFile(null); }} className="text-slate-400 hover:text-red-500"><X className="w-4 h-4" /></button>
                </div>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-purple-300 mb-2" />
                  <div className="text-sm text-slate-600 text-center">Drop Excel file here or <span className="text-purple-600 font-semibold underline">browse</span></div>
                  <div className="text-xs text-slate-400 mt-1">.xlsx files only</div>
                </>
              )}
              <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileChange} accept=".xlsx,.xls" />
            </div>

            <div className="space-y-4 mb-5">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Effective Payment Date</label>
                <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="w-full border border-slate-200 rounded-lg p-2.5 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-100" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Computershare Password</label>
                <div className="relative">
                  <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="w-full border border-slate-200 rounded-lg p-2.5 pr-10 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-100" />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-purple-600">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <button onClick={extractData} disabled={isExtracting || !file} className="w-full bg-slate-900 text-white rounded-xl p-3 text-sm font-bold tracking-wide hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2">
              {isExtracting ? <Loader2 className="w-4 h-4 animate-spin" /> : "EXTRACT DATA"}
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Recent Activity</h2>
            <div className="space-y-0">
              {runs.length === 0 ? <div className="text-sm text-slate-400 text-center py-4">No extraction runs yet.</div> : null}
              {runs.map((r, i) => {
                const ok = r.status === "success";
                return (
                  <div key={i} onClick={() => ok && loadRun(r)} className={`py-3 flex gap-3 border-b border-slate-100 last:border-0 ${ok ? 'cursor-pointer hover:bg-slate-50' : ''}`}>
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">{r.file_name}</div>
                      <div className="text-xs text-slate-500 truncate">{ok ? `${r.records} records · R ${Number(r.total_net_cash).toLocaleString('en-ZA')}` : r.error_message || "Error"}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          {!activeRun ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-12 shadow-sm flex flex-col items-center justify-center text-center min-h-[400px]">
              <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center mb-4">
                <Upload className="text-purple-600 w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-slate-900 mb-2">No extraction run selected</h3>
              <p className="text-sm text-slate-500 max-w-[280px]">Upload an Excel file and click Extract Data, or select a run from Recent Activity.</p>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-sm font-bold text-slate-900">Extraction Result</h2>
                <div className="text-xs text-slate-400">{activeRun.file_name}</div>
              </div>

              <div className="flex gap-6 border-b border-slate-200 mb-6">
                <button onClick={() => setActiveTab("results")} className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === "results" ? "border-purple-600 text-purple-600" : "border-transparent text-slate-500 hover:text-slate-900"}`}>Results</button>
                <button onClick={() => setActiveTab("email")} className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === "email" ? "border-purple-600 text-purple-600" : "border-transparent text-slate-500 hover:text-slate-900"}`}>Email Preview</button>
              </div>

              {activeTab === "results" && (
                <div>
                  <div className="grid grid-cols-3 gap-3 mb-6">
                    <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Holdings</div>
                      <div className="text-xl font-bold text-slate-900">{activeRun.records}</div>
                    </div>
                    <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Net Cash</div>
                      <div className="text-xl font-bold text-slate-900">R {Number(activeRun.total_net_cash).toLocaleString('en-ZA')}</div>
                    </div>
                    <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Unmatched</div>
                      <div className={`text-xl font-bold ${activeRun.unmatched_count === 0 ? "text-emerald-600" : "text-red-600"}`}>{activeRun.unmatched_count || 0}</div>
                    </div>
                  </div>

                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-500 font-bold uppercase tracking-wider">
                        <tr>
                          {payouts[0]?.raw_row && Object.keys(payouts[0].raw_row).slice(0, 6).map((k) => <th key={k} className="p-3 border-b border-slate-200">{k}</th>)}
                          {payouts[0]?.raw_row && Object.keys(payouts[0].raw_row).length > 6 && <th className="p-3 border-b border-slate-200">+ more</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {payouts.slice(0, 100).map((p, idx) => (
                          <tr key={idx} className="hover:bg-slate-50">
                            {Object.keys(p.raw_row).slice(0, 6).map((k) => <td key={k} className="p-3 max-w-[150px] truncate">{p.raw_row[k]}</td>)}
                            {Object.keys(p.raw_row).length > 6 && <td className="p-3 text-slate-400">...</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "email" && (
                <div>
                  <div className="flex gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200 mb-6 items-end">
                    <div className="flex-1">
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">Test Email Address</label>
                      <input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="Enter test email" className="w-full border border-slate-200 rounded-lg p-2 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-100" />
                    </div>
                    <button onClick={sendTestEmail} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-slate-800">Send Test</button>
                    <button onClick={sendAllEmails} className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-emerald-700">Send All Emails</button>
                  </div>

                  <div className="flex gap-4 h-[600px]">
                    <div className="w-[280px] border border-slate-200 rounded-xl bg-white overflow-y-auto divide-y divide-slate-100">
                      {!emailPreview ? <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div> : emailPreview.allClients?.map((c: any) => (
                        <div key={c.client_code} onClick={() => loadEmailForUser(c.client_code)} className={`p-3 cursor-pointer hover:bg-slate-50 transition-colors flex justify-between items-center ${selectedUserCode === c.client_code ? "bg-purple-50" : ""}`}>
                          <div>
                            <div className="text-sm font-bold text-slate-900">{c.first_name}</div>
                            <div className="text-xs text-slate-500">{c.client_code}</div>
                          </div>
                          {c.has_sent && <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full">Sent</span>}
                        </div>
                      ))}
                    </div>
                    <div className="flex-1 border border-slate-200 rounded-xl bg-white flex flex-col overflow-hidden">
                      {emailPreview && selectedUserCode ? (
                        <>
                          <div className="bg-slate-50 border-b border-slate-200 p-3 flex justify-between items-center">
                            <div className="text-sm font-semibold text-slate-700">Subject: {emailPreview.subject}</div>
                            {emailPreview.allClients?.find((c: any) => c.client_code === selectedUserCode)?.has_sent ? (
                              <button disabled className="bg-slate-200 text-slate-500 px-3 py-1.5 rounded-md text-xs font-bold">Already Sent</button>
                            ) : (
                              <button onClick={() => sendEmailToUser(selectedUserCode)} className="bg-purple-600 text-white px-3 py-1.5 rounded-md text-xs font-bold hover:bg-purple-700">Send to User</button>
                            )}
                          </div>
                          <iframe srcDoc={emailPreview.html} className="flex-1 w-full bg-white" />
                        </>
                      ) : (
                        <div className="flex-1 flex items-center justify-center">
                          <Loader2 className="w-6 h-6 animate-spin text-slate-300" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
