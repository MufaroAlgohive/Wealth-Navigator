"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["open", "in_progress", "resolved", "closed"];
const CATEGORIES = ["hardware", "software", "network", "security", "access", "uptime", "api", "policy", "other"];
const ENVS = ["live", "dev", "crm", "supabase", "email", "general"];

interface Incident { id: string; title: string; description: string | null; priority: string; status: string; category: string; environment: string; assigned_to: string | null; reported_by: string | null; notes: string | null; auto_generated: boolean; pending_resolve: boolean; created_at: string; }
interface UptimeLog { id: string; service_name: string; service_key: string; environment: string; url: string | null; is_up: boolean; status_code: number | null; response_ms: number | null; error_message: string | null; checked_at: string; }
interface ApiHealth { id: string; environment: string; endpoint: string; label: string; method: string; actual_status: number | null; response_ms: number | null; passed: boolean; checked_at: string; }
interface PolicyCheck { id: string; policy_name: string; category: string; passed: boolean; severity: string; detail: string | null; recommendation: string | null; target_env: string | null; checked_at: string; }
interface AuditLog { id: string; table_name: string; operation: string; old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null; changed_by: string | null; changed_at: string; }
interface UserActivity { id: string; email: string; display_name: string; initials: string; is_new: boolean; presence: string; last_sign_in: string | null; }
interface UserCounts { online: number; recent: number; inactive: number; never: number; total: number; new_users: number; }
interface HealthSummary { lastChecked: string | null; uptimePct: number | null; apiPassRate: number | null; policyPassRate: number | null; }

const card = "rounded-xl border border-border bg-card";
const th = "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const td = "px-4 py-3 align-top text-[12.5px] text-foreground";

const sevVariant = (s: string): "destructive" | "warning" | "secondary" =>
  s === "critical" || s === "high" ? "destructive" : s === "medium" ? "warning" : "secondary";

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

async function getJson(url: string) {
  try { return await fetch(url).then((r) => r.json()); } catch { return { ok: false }; }
}

export default function CyberCompliancePage() {
  const [tab, setTab] = React.useState("status");
  const [health, setHealth] = React.useState<HealthSummary | null>(null);
  const [migration, setMigration] = React.useState<{ table: string; exists: boolean }[] | null>(null);

  const [uptime, setUptime] = React.useState<UptimeLog[] | null>(null);
  const [selService, setSelService] = React.useState<string | null>(null);
  const [api, setApi] = React.useState<ApiHealth[] | null>(null);
  const [policy, setPolicy] = React.useState<PolicyCheck[] | null>(null);
  const [policyEnv, setPolicyEnv] = React.useState("crm");
  const [audit, setAudit] = React.useState<AuditLog[] | null>(null);
  const [auditOp, setAuditOp] = React.useState("all");
  const [auditTable, setAuditTable] = React.useState("");
  const [users, setUsers] = React.useState<UserActivity[] | null>(null);
  const [userCounts, setUserCounts] = React.useState<UserCounts | null>(null);
  const [userSearch, setUserSearch] = React.useState("");

  // Incidents
  const [incidents, setIncidents] = React.useState<Incident[] | null>(null);
  const [incStatus, setIncStatus] = React.useState("all");
  const [incPriority, setIncPriority] = React.useState("all");
  const [incEnv, setIncEnv] = React.useState("all");
  const [incSearch, setIncSearch] = React.useState("");

  React.useEffect(() => {
    void getJson("/api/admin/cyber-compliance?action=health-summary").then((d) => d.ok && setHealth(d));
    void getJson("/api/admin/cyber-compliance?action=check-migration").then((d) => d.ok && setMigration(d.tables));
  }, []);

  const loadUptime = React.useCallback(async () => {
    setUptime(null);
    const d = await getJson("/api/admin/cyber-compliance?action=list-uptime&limit=200");
    setUptime(d.ok ? d.logs || [] : []);
  }, []);
  const loadApi = React.useCallback(async () => {
    setApi(null);
    const d = await getJson("/api/admin/cyber-compliance?action=list-api-health&limit=200");
    setApi(d.ok ? d.checks || [] : []);
  }, []);
  const loadPolicy = React.useCallback(async () => {
    setPolicy(null);
    const d = await getJson(`/api/admin/cyber-compliance?action=list-policy-checks&env=${policyEnv}`);
    setPolicy(d.ok ? d.checks || [] : []);
  }, [policyEnv]);
  const loadAudit = React.useCallback(async () => {
    setAudit(null);
    const params = new URLSearchParams({ action: "list-audit-log", limit: "200" });
    if (auditOp !== "all") params.set("operation", auditOp);
    if (auditTable.trim()) params.set("table", auditTable.trim());
    const d = await getJson(`/api/admin/cyber-compliance?${params}`);
    setAudit(d.ok ? d.logs || [] : []);
  }, [auditOp, auditTable]);
  const loadUsers = React.useCallback(async () => {
    setUsers(null);
    const d = await getJson("/api/admin/cyber-compliance?action=list-user-activity");
    setUsers(d.ok ? d.users || [] : []);
    setUserCounts(d.ok ? d.counts : null);
  }, []);
  const loadIncidents = React.useCallback(async () => {
    setIncidents(null);
    const params = new URLSearchParams({ action: "list-incidents", limit: "100" });
    if (incStatus !== "all") params.set("status", incStatus);
    if (incPriority !== "all") params.set("priority", incPriority);
    if (incEnv !== "all") params.set("env", incEnv);
    if (incSearch.trim()) params.set("search", incSearch.trim());
    const d = await getJson(`/api/admin/cyber-compliance?${params}`);
    setIncidents(d.ok ? d.incidents || [] : []);
  }, [incStatus, incPriority, incEnv, incSearch]);

  React.useEffect(() => {
    if (tab === "status") void loadUptime();
    if (tab === "api") void loadApi();
    if (tab === "policy") void loadPolicy();
    if (tab === "audit") void loadAudit();
    if (tab === "users") void loadUsers();
    if (tab === "incidents") void loadIncidents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  React.useEffect(() => { if (tab === "policy") void loadPolicy(); }, [policyEnv, tab, loadPolicy]);
  React.useEffect(() => { if (tab === "incidents") void loadIncidents(); }, [incStatus, incPriority, incEnv, tab, loadIncidents]);

  // Service grid: latest log per service_key
  const services = React.useMemo(() => {
    const m: Record<string, UptimeLog> = {};
    for (const l of uptime ?? []) if (!m[l.service_key]) m[l.service_key] = l;
    return Object.values(m);
  }, [uptime]);
  const recentUptime = React.useMemo(
    () => (uptime ?? []).filter((l) => !selService || l.service_key === selService).slice(0, 80),
    [uptime, selService],
  );
  const filteredUsers = React.useMemo(
    () => (users ?? []).filter((u) => !userSearch.trim() || `${u.display_name} ${u.email}`.toLowerCase().includes(userSearch.toLowerCase())),
    [users, userSearch],
  );

  // ── Incident modal ──
  const blankInc = { id: "", title: "", description: "", priority: "medium", status: "open", category: "other", environment: "general", assigned_to: "", reported_by: "", notes: "" };
  const [incOpen, setIncOpen] = React.useState(false);
  const [incForm, setIncForm] = React.useState(blankInc);
  const [busy, setBusy] = React.useState(false);
  const openNewIncident = () => { setIncForm(blankInc); setIncOpen(true); };
  const openEditIncident = (i: Incident) => {
    setIncForm({ id: i.id, title: i.title, description: i.description || "", priority: i.priority, status: i.status, category: i.category, environment: i.environment, assigned_to: i.assigned_to || "", reported_by: i.reported_by || "", notes: i.notes || "" });
    setIncOpen(true);
  };
  const saveIncident = async () => {
    if (!incForm.title.trim()) return toast.error("Title is required");
    setBusy(true);
    try {
      const action = incForm.id ? "update-incident" : "create-incident";
      const d = await fetch(`/api/admin/cyber-compliance?action=${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(incForm),
      }).then((r) => r.json());
      if (d.ok) { setIncOpen(false); await loadIncidents(); toast.success(incForm.id ? "Incident updated" : "Incident created"); }
      else toast.error(d.error || "Failed");
    } finally { setBusy(false); }
  };
  const incidentAction = async (action: string, id: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const d = await fetch(`/api/admin/cyber-compliance?action=${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (d.ok) await loadIncidents();
    else toast.error(d.error || "Failed");
  };
  const checkNow = async () => {
    const d = await fetch(`/api/admin/cyber-compliance?action=run-policy-checks-live&env=${policyEnv}`, { method: "POST" }).then((r) => r.json());
    if (d.notice) toast.message(d.notice);
    await loadPolicy();
  };
  const purgeKyc = async () => {
    if (!window.confirm("Purge system KYC polling entries from the audit log?")) return;
    const d = await fetch("/api/admin/cyber-compliance?action=purge-kyc-audit", { method: "POST" }).then((r) => r.json());
    if (d.ok) { toast.success(`Purged ${d.deleted} entries`); await loadAudit(); } else toast.error(d.error || "Failed");
  };

  const missing = (migration ?? []).filter((t) => !t.exists);

  return (
    <div className="mx-auto max-w-6xl">
      {migration && missing.length > 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground/90">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>Missing tables: <strong>{missing.map((t) => t.table).join(", ")}</strong>. Paste the cyber-compliance SQL in the Supabase SQL editor (migration runner is deferred).</span>
        </div>
      )}

      {/* Health strip */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Last Check" value={health ? fmtTime(health.lastChecked) : "—"} />
        <Kpi label="Uptime (24h)" value={health?.uptimePct != null ? `${health.uptimePct}%` : "—"} />
        <Kpi label="API Pass Rate" value={health?.apiPassRate != null ? `${health.apiPassRate}%` : "—"} />
        <Kpi label="Policy Pass Rate" value={health?.policyPassRate != null ? `${health.policyPassRate}%` : "—"} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="api">API Health</TabsTrigger>
          <TabsTrigger value="incidents">Incidents</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
          <TabsTrigger value="policy">Policy Checks</TabsTrigger>
          <TabsTrigger value="users">User Activity</TabsTrigger>
        </TabsList>

        {/* STATUS */}
        <TabsContent value="status" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {services.map((s) => (
              <button key={s.service_key} onClick={() => setSelService(selService === s.service_key ? null : s.service_key)}
                className={cn("rounded-xl border bg-card p-4 text-left", selService === s.service_key ? "border-primary" : "border-border")}>
                <div className="flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", s.is_up ? "bg-success" : "bg-destructive")} />
                  <span className="text-sm font-semibold text-foreground">{s.service_name}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{s.is_up ? "Operational" : "Down"} · {s.response_ms ?? "—"}ms · {fmtTime(s.checked_at)}</div>
              </button>
            ))}
            {services.length === 0 && uptime !== null && <p className="col-span-full py-6 text-center text-xs text-muted-foreground">No services monitored.</p>}
          </div>
          <DataTable cols={["Service", "Status", "Response", "Code", "Checked"]} rows={recentUptime} empty={uptime === null ? "Loading…" : "No uptime entries."}
            render={(l) => (
              <>
                <td className={td}>{l.service_name} <span className="text-[10px] text-muted-foreground">({l.environment})</span></td>
                <td className={td}><Badge variant={l.is_up ? "success" : "destructive"}>{l.is_up ? "UP" : "DOWN"}</Badge></td>
                <td className={td}>{l.response_ms ?? "—"}ms</td>
                <td className={td}>{l.status_code ?? "—"}</td>
                <td className={td}>{fmtTime(l.checked_at)}</td>
              </>
            )} />
        </TabsContent>

        {/* API HEALTH */}
        <TabsContent value="api">
          <DataTable cols={["Endpoint", "Method", "Result", "Code", "Response", "Checked"]} rows={api} empty={api === null ? "Loading…" : "No API checks."}
            render={(c) => (
              <>
                <td className={td}><div className="font-medium">{c.label}</div><div className="font-mono text-[10.5px] text-muted-foreground">{c.endpoint}</div></td>
                <td className={td}>{c.method}</td>
                <td className={td}><Badge variant={c.passed ? "success" : "destructive"}>{c.passed ? "PASS" : "FAIL"}</Badge></td>
                <td className={td}>{c.actual_status ?? "—"}</td>
                <td className={td}>{c.response_ms ?? "—"}ms</td>
                <td className={td}>{fmtTime(c.checked_at)}</td>
              </>
            )} />
        </TabsContent>

        {/* INCIDENTS */}
        <TabsContent value="incidents" className="space-y-4">
          <div className={cn(card, "flex flex-wrap items-center gap-3 p-4")}>
            <FilterSelect value={incStatus} onChange={setIncStatus} all="All statuses" opts={STATUSES} />
            <FilterSelect value={incPriority} onChange={setIncPriority} all="All priorities" opts={PRIORITIES} />
            <FilterSelect value={incEnv} onChange={setIncEnv} all="All envs" opts={ENVS} />
            <Input value={incSearch} onChange={(e) => setIncSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadIncidents()} placeholder="Search…" className="h-8 w-44" />
            <Button variant="secondary" size="sm" onClick={loadIncidents}>Search</Button>
            <div className="flex-1" />
            <Button size="sm" onClick={openNewIncident}>+ New Incident</Button>
          </div>
          <div className={card}>
            <DataTable cols={["Incident", "Env", "Priority", "Status", "Created", "Actions"]} rows={incidents} empty={incidents === null ? "Loading…" : "No incidents."}
              render={(i) => (
                <>
                  <td className={td}>
                    <div className="font-semibold">{i.title}</div>
                    <div className="mt-0.5 flex gap-1.5 text-[10px] text-muted-foreground">
                      {i.auto_generated && <span className="rounded bg-muted px-1.5">auto</span>}
                      {i.pending_resolve && <span className="rounded bg-warning/15 px-1.5 text-warning">pending resolve</span>}
                      <span>{i.category}</span>
                    </div>
                  </td>
                  <td className={td}>{i.environment}</td>
                  <td className={td}><Badge variant={sevVariant(i.priority)}>{i.priority}</Badge></td>
                  <td className={td}><Badge variant={i.status === "resolved" || i.status === "closed" ? "success" : i.status === "open" ? "warning" : "secondary"}>{i.status}</Badge></td>
                  <td className={td}>{fmtTime(i.created_at)}</td>
                  <td className={td}>
                    <div className="flex gap-1.5">
                      <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" onClick={() => openEditIncident(i)}>Edit</Button>
                      {i.pending_resolve && <Button size="sm" className="h-7 px-2 text-[11px]" onClick={() => incidentAction("confirm-resolve", i.id)}>Confirm</Button>}
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10" onClick={() => incidentAction("delete-incident", i.id, "Delete this incident?")}>Delete</Button>
                    </div>
                  </td>
                </>
              )} />
          </div>
        </TabsContent>

        {/* AUDIT */}
        <TabsContent value="audit" className="space-y-4">
          <div className={cn(card, "flex flex-wrap items-center gap-3 p-4")}>
            <FilterSelect value={auditOp} onChange={setAuditOp} all="All operations" opts={["INSERT", "UPDATE", "DELETE"]} />
            <Input value={auditTable} onChange={(e) => setAuditTable(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadAudit()} placeholder="table name…" className="h-8 w-44" />
            <Button variant="secondary" size="sm" onClick={loadAudit}>Filter</Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={purgeKyc}>Purge KYC logs</Button>
          </div>
          <div className={card}>
            <DataTable cols={["Time", "Table", "Operation", "Changed By", "What Changed"]} rows={audit} empty={audit === null ? "Loading…" : "No audit entries."}
              render={(e) => (
                <>
                  <td className={td}>{fmtTime(e.changed_at)}</td>
                  <td className={td}><code className="font-mono text-[11px]">{e.table_name}</code></td>
                  <td className={td}><Badge variant={e.operation === "DELETE" ? "destructive" : e.operation === "INSERT" ? "success" : "warning"}>{e.operation}</Badge></td>
                  <td className={td}>{e.changed_by || "system"}</td>
                  <td className={cn(td, "max-w-[320px]")}><AuditDiff entry={e} /></td>
                </>
              )} />
          </div>
        </TabsContent>

        {/* POLICY */}
        <TabsContent value="policy" className="space-y-4">
          <div className={cn(card, "flex flex-wrap items-center gap-2 p-4")}>
            {["crm", "live", "dev"].map((e) => (
              <Button key={e} variant={policyEnv === e ? "default" : "secondary"} size="sm" onClick={() => setPolicyEnv(e)}>{e.toUpperCase()}</Button>
            ))}
            <div className="flex-1" />
            <Button variant="secondary" size="sm" onClick={checkNow}>Check Now</Button>
          </div>
          <div className={card}>
            <DataTable cols={["Policy", "Category", "Severity", "Result", "Detail"]} rows={policy} empty={policy === null ? "Loading…" : "No policy checks for this environment."}
              render={(p) => (
                <>
                  <td className={td}><div className="font-medium">{p.policy_name}</div>{p.recommendation && !p.passed && <div className="mt-0.5 text-[10.5px] text-muted-foreground">{p.recommendation}</div>}</td>
                  <td className={td}>{p.category}</td>
                  <td className={td}><Badge variant={sevVariant(p.severity)}>{p.severity}</Badge></td>
                  <td className={td}><Badge variant={p.passed ? "success" : "destructive"}>{p.passed ? "PASS" : "FAIL"}</Badge></td>
                  <td className={cn(td, "max-w-[320px] text-muted-foreground")}>{p.detail}</td>
                </>
              )} />
          </div>
        </TabsContent>

        {/* USER ACTIVITY */}
        <TabsContent value="users" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Online now" value={userCounts ? String(userCounts.online) : "—"} />
            <Kpi label="Active (24h)" value={userCounts ? String(userCounts.recent) : "—"} />
            <Kpi label="New (30d)" value={userCounts ? String(userCounts.new_users) : "—"} />
            <Kpi label="Total" value={userCounts ? String(userCounts.total) : "—"} />
          </div>
          <Input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Search users…" className="h-9 max-w-sm" />
          {users === null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredUsers.map((u) => (
                <div key={u.id} className={cn(card, "flex items-center gap-3 p-3")}>
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-[12px] font-bold text-primary">{u.initials}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                      {u.display_name}
                      {u.is_new && <span className="rounded bg-success/15 px-1 text-[9px] font-bold text-success">NEW</span>}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{u.email}</div>
                  </div>
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", u.presence === "online" ? "bg-success" : u.presence === "recent" ? "bg-warning" : "bg-muted-foreground/40")} title={u.presence} />
                </div>
              ))}
              {filteredUsers.length === 0 && <p className="col-span-full py-6 text-center text-xs text-muted-foreground">No users.</p>}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Incident modal */}
      <Dialog open={incOpen} onOpenChange={setIncOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{incForm.id ? "Edit Incident" : "New Incident"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Labeled label="Title"><Input value={incForm.title} onChange={(e) => setIncForm((f) => ({ ...f, title: e.target.value }))} /></Labeled>
            <Labeled label="Description"><textarea rows={2} value={incForm.description} onChange={(e) => setIncForm((f) => ({ ...f, description: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" /></Labeled>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="Priority"><PlainSelect value={incForm.priority} onChange={(v) => setIncForm((f) => ({ ...f, priority: v }))} opts={PRIORITIES} /></Labeled>
              <Labeled label="Status"><PlainSelect value={incForm.status} onChange={(v) => setIncForm((f) => ({ ...f, status: v }))} opts={STATUSES} /></Labeled>
              <Labeled label="Category"><PlainSelect value={incForm.category} onChange={(v) => setIncForm((f) => ({ ...f, category: v }))} opts={CATEGORIES} /></Labeled>
              <Labeled label="Environment"><PlainSelect value={incForm.environment} onChange={(v) => setIncForm((f) => ({ ...f, environment: v }))} opts={ENVS} /></Labeled>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="Assigned to"><Input value={incForm.assigned_to} onChange={(e) => setIncForm((f) => ({ ...f, assigned_to: e.target.value }))} /></Labeled>
              <Labeled label="Reported by"><Input value={incForm.reported_by} onChange={(e) => setIncForm((f) => ({ ...f, reported_by: e.target.value }))} /></Labeled>
            </div>
            <Labeled label="Notes"><textarea rows={2} value={incForm.notes} onChange={(e) => setIncForm((f) => ({ ...f, notes: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" /></Labeled>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setIncOpen(false)}>Cancel</Button>
            <Button onClick={saveIncident} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}
function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-[12px] font-semibold text-foreground">{label}</label>{children}</div>;
}
function FilterSelect({ value, onChange, all, opts }: { value: string; onChange: (v: string) => void; all: string; opts: string[] }) {
  return (
    <div className="w-40">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{all}</SelectItem>
          {opts.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
function PlainSelect({ value, onChange, opts }: { value: string; onChange: (v: string) => void; opts: string[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>{opts.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
    </Select>
  );
}
function DataTable<T extends { id: string }>({ cols, rows, empty, render }: { cols: string[]; rows: T[] | null; empty: string; render: (r: T) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse">
        <thead><tr className="border-b border-border bg-card">{cols.map((c) => <th key={c} className={th}>{c}</th>)}</tr></thead>
        <tbody>
          {rows === null || rows.length === 0 ? (
            <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</td></tr>
          ) : (
            rows.map((r) => <tr key={r.id} className="border-b border-border/40 last:border-b-0 hover:bg-accent/20">{render(r)}</tr>)
          )}
        </tbody>
      </table>
    </div>
  );
}
function AuditDiff({ entry }: { entry: AuditLog }) {
  const keys = new Set<string>([...Object.keys(entry.old_row ?? {}), ...Object.keys(entry.new_row ?? {})]);
  const changed: string[] = [];
  for (const k of keys) {
    const a = JSON.stringify((entry.old_row ?? {})[k]);
    const b = JSON.stringify((entry.new_row ?? {})[k]);
    if (a !== b) changed.push(`${k}: ${a ?? "∅"} → ${b ?? "∅"}`);
  }
  if (entry.operation === "INSERT") return <span className="text-[11px] text-muted-foreground">row created</span>;
  if (entry.operation === "DELETE") return <span className="text-[11px] text-muted-foreground">row deleted</span>;
  return <span className="font-mono text-[10.5px] text-muted-foreground">{changed.slice(0, 4).join(" · ") || "—"}</span>;
}
