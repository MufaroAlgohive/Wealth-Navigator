"use client";

import * as React from "react";
import { toast } from "sonner";

import { useAdmin } from "@/lib/admin/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

// ── Reference data (mirrors team.html) ──────────────────────────────────────
const ALL_PAGES = [
  { key: "clients", label: "Clients" },
  { key: "dashboard", label: "Dashboard" },
  { key: "strategies", label: "Strategies" },
  { key: "factsheets", label: "Factsheets" },
  { key: "investors", label: "Investors" },
  { key: "eft", label: "EFT Payments" },
  { key: "orderbook", label: "Order Book" },
  { key: "settings", label: "Settings" },
];

type PermValue = boolean | string;
interface PermField {
  key: string;
  label: string;
  desc: string;
  type: "toggle" | "tristate";
  options?: { value: PermValue; label: string }[];
}
interface PermSection {
  key: string;
  label: string;
  icon: string;
  fields: PermField[];
}
const PERMISSION_MATRIX: PermSection[] = [
  {
    key: "orderbook", label: "Order Book", icon: "📋",
    fields: [
      { key: "send_confirmation", label: "Send Trade Confirmations", desc: "How trade confirmation emails can be dispatched to clients", type: "tristate", options: [{ value: false, label: "Blocked" }, { value: "test_only", label: "Test → Approver" }, { value: "full", label: "Full Send" }] },
      { key: "edit_fill_price", label: "Edit Fill Price", desc: "Enter and commit fill prices for trades", type: "tristate", options: [{ value: false, label: "Blocked" }, { value: "pending", label: "Pending Approval" }, { value: "direct", label: "Direct" }] },
      { key: "refund_investor", label: "Refund / Reverse Investor", desc: "Eject an investor and return funds to their wallet", type: "toggle" },
      { key: "export", label: "Export Order Book CSV", desc: "Download order book data as a CSV file", type: "toggle" },
    ],
  },
  {
    key: "dashboard", label: "Dashboard", icon: "📊",
    fields: [
      { key: "view_financials", label: "View Financials", desc: "Total AUM, investor count, and wallet balances", type: "toggle" },
      { key: "commit_rebalance", label: "Commit Rebalance", desc: "Execute a strategy rebalance", type: "tristate", options: [{ value: false, label: "Blocked" }, { value: "pending", label: "Proposal Only" }, { value: "direct", label: "Direct Commit" }] },
      { key: "sync_fundamentals", label: "Sync Market Data", desc: "Trigger external market data synchronisation", type: "toggle" },
    ],
  },
  {
    key: "eft", label: "EFT & Wallet", icon: "💳",
    fields: [
      { key: "approve_deposits", label: "Approve / Reject Deposits", desc: "Authorise incoming client EFT payments", type: "toggle" },
      { key: "manual_funds", label: "Add Manual Funds", desc: "Credit a client's wallet balance manually", type: "toggle" },
    ],
  },
  {
    key: "clients", label: "Clients", icon: "👥",
    fields: [
      { key: "manage_kyc", label: "Manage KYC", desc: "Review and update client KYC status", type: "toggle" },
      { key: "edit_profiles", label: "Edit Profiles", desc: "Modify client profile information", type: "toggle" },
    ],
  },
  {
    key: "strategies", label: "Strategies", icon: "🎯",
    fields: [
      { key: "manage_strategies", label: "Manage Strategies", desc: "Create, edit, and delete investment strategies", type: "toggle" },
      { key: "change_visibility", label: "Change Strategy Visibility", desc: "Switch a strategy from private to public", type: "tristate", options: [{ value: false, label: "Blocked" }, { value: "pending", label: "Pending Approval" }, { value: "direct", label: "Direct" }] },
    ],
  },
  {
    key: "factsheets", label: "Factsheets", icon: "📄",
    fields: [{ key: "upload_factsheets", label: "Upload Factsheets", desc: "Upload strategy factsheet PDFs", type: "toggle" }],
  },
];

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  trade_confirmation: "Trade Confirmation",
  fill_price: "Fill Price",
  rebalance: "Rebalance",
  strategy_visibility: "Strategy Visibility",
  other: "Other",
};

interface Member {
  id: string;
  full_name: string | null;
  email: string;
  role: string;
  page_access: string[] | null;
  approver_tier: string | null;
  permissions: Record<string, Record<string, PermValue>> | null;
  status: string;
  last_sign_in_at?: string | null;
}
interface Approval {
  id: string;
  type: string;
  status: string;
  requested_by_email: string;
  created_at: string;
  payload: Record<string, unknown> | null;
  notes: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
}
interface AuditEntry {
  id: string;
  action: string;
  target_email: string | null;
  actor_email: string | null;
  created_at: string;
  details: Record<string, unknown> | null;
}

type PermValues = Record<string, Record<string, PermValue>>;

function lastTristate(f: PermField): PermValue {
  const opts = f.options ?? [];
  const last = opts[opts.length - 1];
  return last ? last.value : false;
}

function buildPerms(source: Record<string, Record<string, unknown>> | null, forceDev: boolean): PermValues {
  const out: PermValues = {};
  for (const s of PERMISSION_MATRIX) {
    const sec: Record<string, PermValue> = {};
    for (const f of s.fields) {
      if (forceDev) {
        sec[f.key] = f.type === "toggle" ? true : lastTristate(f);
      } else {
        const cur = source?.[s.key]?.[f.key];
        sec[f.key] = f.type === "toggle" ? !!cur : (cur !== undefined ? (cur as PermValue) : false);
      }
    }
    out[s.key] = sec;
  }
  return out;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function describeAudit(e: AuditEntry): string {
  const d = e.details || {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  switch (e.action) {
    case "invite": {
      const role = d.role ? ` as ${d.role}` : "";
      const pages = arr(d.page_access).length ? ` — pages: ${arr(d.page_access).join(", ")}` : "";
      const sent = d.email_sent === false ? " · email not sent" : "";
      return `Invited${role}${pages}${sent}`;
    }
    case "update": {
      const before = (d.before || {}) as Record<string, unknown>;
      const after = (d.after || {}) as Record<string, unknown>;
      const parts: string[] = [];
      if (before.role !== after.role && after.role) parts.push(`role: ${before.role || "—"} → ${after.role}`);
      if (before.approver_tier !== after.approver_tier) parts.push(`tier: ${before.approver_tier || "staff"} → ${after.approver_tier || "staff"}`);
      const bp = arr(before.page_access).slice().sort().join(",");
      const ap = arr(after.page_access).slice().sort().join(",");
      if (bp !== ap) parts.push(`pages: ${bp || "—"} → ${ap || "—"}`);
      if (before.permissions !== undefined || after.permissions !== undefined) parts.push("permissions updated");
      if (d.email_changed_to) parts.push(`email → ${d.email_changed_to}`);
      return parts.length ? parts.join(" · ") : "No changes";
    }
    case "remove":
      return `Removed${d.role ? ` (was ${d.role})` : ""}`;
    case "signup":
      return `Completed signup${d.full_name ? ` as ${d.full_name}` : ""}`;
    case "impersonate": {
      const env = d.mint_environment ? ` ${d.mint_environment}` : "";
      const name = d.target_name ? ` (${d.target_name})` : "";
      return `Viewed Mint as client${name} on${env}`;
    }
    default:
      return JSON.stringify(d);
  }
}

function fmtPayload(payload: Record<string, unknown> | null): string {
  if (!payload || typeof payload !== "object") return "—";
  const lines: string[] = [];
  const safe = (k: string, v: unknown) => `${k}: ${String(v == null ? "—" : v)}`;
  if (payload.instrument) lines.push(safe("Instrument", payload.instrument));
  if (payload.ticker) lines.push(safe("Ticker", payload.ticker));
  if (payload.newPriceRand != null) lines.push(safe("Fill Price", `R ${Number(payload.newPriceRand).toFixed(2)}`));
  if (payload.side) lines.push(safe("Side", payload.side));
  if (Array.isArray(payload.ids)) lines.push(safe("Records", payload.ids.length));
  if (payload.strategy) lines.push(safe("Strategy", payload.strategy));
  if (payload.subject) lines.push(safe("Subject", payload.subject));
  if (!lines.length) {
    Object.keys(payload).filter((k) => !["html", "text", "dbPayload", "ids"].includes(k)).slice(0, 5).forEach((k) => lines.push(safe(k, payload[k])));
  }
  return lines.join("\n") || JSON.stringify(payload, null, 2);
}

const cardClass = "rounded-xl border border-border bg-card";
const thClass = "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const tdClass = "px-4 py-3 align-middle text-[13px] text-foreground";

export default function TeamPage() {
  const { ctx } = useAdmin();
  const canResolve = ctx.approverTier === "dev" || ctx.approverTier === "master";

  const [tab, setTab] = React.useState("members");

  // Members
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [membersError, setMembersError] = React.useState(false);
  const myId = React.useMemo(
    () => members?.find((m) => m.email.toLowerCase() === ctx.email.toLowerCase())?.id ?? null,
    [members, ctx.email],
  );

  const loadTeam = React.useCallback(async () => {
    try {
      const d = await fetch("/api/admin/team?action=list").then((r) => r.json());
      if (d.ok) {
        setMembers(d.members);
        setMembersError(false);
      } else setMembersError(true);
    } catch {
      setMembersError(true);
    }
  }, []);

  React.useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  const stats = React.useMemo(() => {
    const m = members ?? [];
    return {
      total: m.length,
      dev: m.filter((x) => x.approver_tier === "dev").length,
      master: m.filter((x) => x.approver_tier === "master").length,
      pending: m.filter((x) => x.status === "pending").length,
    };
  }, [members]);

  // ── Invite modal ──
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [invName, setInvName] = React.useState("");
  const [invEmail, setInvEmail] = React.useState("");
  const [invRole, setInvRole] = React.useState("staff");
  const [invPages, setInvPages] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const openInvite = () => {
    setInvName(""); setInvEmail(""); setInvRole("staff"); setInvPages(new Set());
    setInviteOpen(true);
  };
  const submitInvite = async () => {
    const email = invEmail.trim().toLowerCase();
    if (!email) return toast.error("Email is required");
    if (!email.endsWith("@mymint.co.za")) return toast.error("Only @mymint.co.za addresses can be invited.");
    setBusy(true);
    try {
      const d = await fetch("/api/admin/team?action=invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, full_name: invName.trim(), role: invRole, page_access: invRole === "staff" ? [...invPages] : [] }),
      }).then((r) => r.json());
      if (d.ok) {
        setInviteOpen(false);
        await loadTeam();
        if (!d.emailSent) toast.message(d.emailReason || "Member added (pending).");
      } else toast.error(d.error || "Failed to invite member");
    } finally {
      setBusy(false);
    }
  };

  // ── Edit role modal ──
  const [editOpen, setEditOpen] = React.useState(false);
  const [editId, setEditId] = React.useState("");
  const [editRole, setEditRole] = React.useState("staff");
  const [editPages, setEditPages] = React.useState<Set<string>>(new Set());
  const openEdit = (m: Member) => {
    setEditId(m.id); setEditRole(m.role); setEditPages(new Set(m.page_access ?? []));
    setEditOpen(true);
  };
  const submitEdit = async () => {
    setBusy(true);
    try {
      const d = await fetch("/api/admin/team?action=update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editId, role: editRole, page_access: editRole === "staff" ? [...editPages] : [] }),
      }).then((r) => r.json());
      if (d.ok) { setEditOpen(false); await loadTeam(); } else toast.error(d.error || "Failed to update member");
    } finally {
      setBusy(false);
    }
  };

  // ── Update email modal ──
  const [emailOpen, setEmailOpen] = React.useState(false);
  const [emailId, setEmailId] = React.useState("");
  const [emailCurrent, setEmailCurrent] = React.useState("");
  const [emailNew, setEmailNew] = React.useState("");
  const [emailErr, setEmailErr] = React.useState("");
  const openEmail = (m: Member) => {
    setEmailId(m.id); setEmailCurrent(m.email); setEmailNew(""); setEmailErr("");
    setEmailOpen(true);
  };
  const submitEmail = async () => {
    const ne = emailNew.trim().toLowerCase();
    if (!ne) return setEmailErr("Enter the new email address.");
    if (!ne.endsWith("@mymint.co.za")) return setEmailErr("Must be a @mymint.co.za address.");
    setBusy(true);
    try {
      const d = await fetch("/api/admin/team?action=update-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: emailId, new_email: ne }),
      }).then((r) => r.json());
      if (d.ok) {
        setEmailOpen(false);
        await loadTeam();
        toast.message(d.authUpdated ? "Email updated." : "Team record updated (auth email change deferred).");
      } else setEmailErr(d.error || "Failed to update email.");
    } finally {
      setBusy(false);
    }
  };

  // ── Permissions modal ──
  const [permOpen, setPermOpen] = React.useState(false);
  const [permId, setPermId] = React.useState("");
  const [permEmail, setPermEmail] = React.useState("");
  const [permTier, setPermTier] = React.useState("");
  const [permValues, setPermValues] = React.useState<PermValues>({});
  const [accOpen, setAccOpen] = React.useState<Set<string>>(new Set());
  const openPerms = (m: Member) => {
    setPermId(m.id); setPermEmail(m.email);
    const tier = m.approver_tier || "";
    setPermTier(tier);
    setPermValues(buildPerms(m.permissions, tier === "dev"));
    setAccOpen(new Set());
    setPermOpen(true);
  };
  const onTierChange = (v: string) => {
    setPermTier(v);
    if (v === "dev") setPermValues(buildPerms(null, true));
  };
  const isDev = permTier === "dev";
  const setFieldVal = (section: string, field: string, value: PermValue) =>
    setPermValues((p) => ({ ...p, [section]: { ...p[section], [field]: value } }));
  const submitPerms = async () => {
    const permissions = isDev ? buildPerms(null, true) : permValues;
    setBusy(true);
    try {
      const d = await fetch("/api/admin/team?action=update-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: permId, approver_tier: permTier || null, permissions }),
      }).then((r) => r.json());
      if (d.ok) { setPermOpen(false); await loadTeam(); } else toast.error(d.error || "Failed to save permissions");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (m: Member) => {
    if (!window.confirm(`Remove ${m.full_name || m.email} from the team?`)) return;
    const d = await fetch("/api/admin/team?action=remove", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: m.id }),
    }).then((r) => r.json());
    if (d.ok) await loadTeam();
    else toast.error(d.error || "Failed to remove member");
  };

  // ── Approvals ──
  const [approvals, setApprovals] = React.useState<Approval[] | null>(null);
  const [apStatus, setApStatus] = React.useState("pending");
  const [apType, setApType] = React.useState("all");
  const [apNotice, setApNotice] = React.useState<string | null>(null);
  const loadApprovals = React.useCallback(async () => {
    setApprovals(null);
    const params = new URLSearchParams({ action: "list-approvals", status: apStatus, limit: "200" });
    if (apType !== "all") params.set("type", apType);
    const d = await fetch(`/api/admin/team?${params}`).then((r) => r.json());
    setApNotice(d.notice || null);
    setApprovals(d.ok ? d.approvals || [] : []);
  }, [apStatus, apType]);
  const resolveApproval = async (id: string, decision: "approved" | "rejected", notes: string) => {
    const d = await fetch("/api/admin/team?action=resolve-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision, notes: notes || null }),
    }).then((r) => r.json());
    if (!d.ok) return toast.error(d.error || "Could not resolve approval");
    await loadApprovals();
  };

  // ── Audit ──
  const [audit, setAudit] = React.useState<AuditEntry[] | null>(null);
  const [auditNotice, setAuditNotice] = React.useState<string | null>(null);
  const loadAudit = React.useCallback(async () => {
    setAudit(null);
    const d = await fetch("/api/admin/team?action=audit-list&limit=200").then((r) => r.json());
    setAuditNotice(d.notice || null);
    setAudit(d.ok ? d.entries || [] : []);
  }, []);

  // ── Impersonation ──
  const [imp, setImp] = React.useState<AuditEntry[] | null>(null);
  const [impNotice, setImpNotice] = React.useState<string | null>(null);
  const [impAdmin, setImpAdmin] = React.useState("");
  const [impClient, setImpClient] = React.useState("");
  const [impFrom, setImpFrom] = React.useState("");
  const [impTo, setImpTo] = React.useState("");
  const loadImp = React.useCallback(async () => {
    setImp(null);
    const params = new URLSearchParams({ action: "audit-list", audit_action: "impersonate", limit: "200" });
    if (impAdmin.trim()) params.set("actor_email", impAdmin.trim());
    if (impClient.trim()) params.set("target_email", impClient.trim());
    if (impFrom) params.set("from", `${impFrom}T00:00:00Z`);
    if (impTo) params.set("to", `${impTo}T23:59:59Z`);
    const d = await fetch(`/api/admin/team?${params}`).then((r) => r.json());
    setImpNotice(d.notice || null);
    setImp(d.ok ? d.entries || [] : []);
  }, [impAdmin, impClient, impFrom, impTo]);

  React.useEffect(() => {
    if (tab === "approvals") void loadApprovals();
    if (tab === "audit") void loadAudit();
    if (tab === "impersonation") void loadImp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const pendingApprovalCount = approvals?.filter((a) => a.status === "pending").length ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total Members" value={stats.total} />
        <Stat label="Dev ◆ Users" value={stats.dev} />
        <Stat label="Master ★ Approvers" value={stats.master} />
        <Stat label="Pending Invites" value={stats.pending} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="approvals">
            Approvals{pendingApprovalCount > 0 ? ` (${pendingApprovalCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
          <TabsTrigger value="impersonation">Impersonation</TabsTrigger>
        </TabsList>

        {/* ── MEMBERS ── */}
        <TabsContent value="members">
          <div className={cardClass}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-bold text-foreground">Staff Roster</span>
              <Button onClick={openInvite}>Invite Member</Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className={thClass}>Member</th>
                    <th className={thClass}>Tier</th>
                    <th className={thClass}>Role</th>
                    <th className={thClass}>Page Access</th>
                    <th className={thClass}>Status</th>
                    <th className={thClass}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members === null && !membersError ? (
                    <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
                  ) : membersError ? (
                    <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">Could not load team (access denied or not configured).</td></tr>
                  ) : members && members.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">No team members yet.</td></tr>
                  ) : (
                    members?.map((m) => (
                      <tr key={m.id} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                        <td className={tdClass}>
                          <div className="font-semibold">{m.full_name || "—"}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">{m.email}</div>
                          {m.last_sign_in_at && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">Last login: {new Date(m.last_sign_in_at).toLocaleDateString("en-ZA")}</div>
                          )}
                        </td>
                        <td className={tdClass}><TierBadge tier={m.approver_tier} /></td>
                        <td className={tdClass}><RolePill role={m.role} /></td>
                        <td className={tdClass}>
                          {m.role === "admin" ? (
                            <span className="rounded-md bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">All pages</span>
                          ) : (m.page_access?.length ? (
                            <div className="flex flex-wrap gap-1">
                              {m.page_access.map((k) => (
                                <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{k}</span>
                              ))}
                            </div>
                          ) : <span className="text-[11px] text-muted-foreground">No access</span>)}
                        </td>
                        <td className={tdClass}>
                          {m.status === "pending" ? (
                            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">Pending</span>
                          ) : (
                            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">Active</span>
                          )}
                        </td>
                        <td className={tdClass}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" onClick={() => openEdit(m)}>Role</Button>
                            <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" onClick={() => openPerms(m)}>Permissions</Button>
                            {!m.email.endsWith("@mymint.co.za") && (
                              <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" onClick={() => openEmail(m)}>Update Email</Button>
                            )}
                            {m.id !== myId && (
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10" onClick={() => removeMember(m)}>Remove</Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* ── APPROVALS ── */}
        <TabsContent value="approvals">
          <div className={cn(cardClass, "p-5")}>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="flex-1">
                <div className="text-sm font-bold text-foreground">Approvals Inbox</div>
                <div className="text-xs text-muted-foreground">Review and authorize pending requests from lower-level staff.</div>
              </div>
              <div className="w-36"><Select value={apStatus} onValueChange={setApStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                {["pending", "approved", "rejected", "all"].map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
              </SelectContent></Select></div>
              <div className="w-44"><Select value={apType} onValueChange={setApType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {Object.entries(APPROVAL_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent></Select></div>
              <Button variant="secondary" size="sm" onClick={loadApprovals}>Refresh</Button>
            </div>
            {apNotice && <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground/80">{apNotice}</div>}
            {approvals === null ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading approvals…</p>
            ) : approvals.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No approvals found for the selected filters.</p>
            ) : (
              <div className="space-y-3">
                {approvals.map((a) => (
                  <ApprovalCard key={a.id} a={a} canResolve={canResolve} onResolve={resolveApproval} />
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── AUDIT ── */}
        <TabsContent value="audit">
          <div className={cardClass}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-bold text-foreground">Audit Log</span>
              <Button variant="secondary" size="sm" onClick={loadAudit}>Refresh</Button>
            </div>
            {auditNotice && <div className="m-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground/80">{auditNotice}</div>}
            <AuditTable entries={audit} cols={["When", "Action", "Target", "Performed by", "Details"]}
              render={(e) => (
                <>
                  <td className={tdClass}><span className="text-[11px] text-muted-foreground">{fmtWhen(e.created_at)}</span></td>
                  <td className={tdClass}><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold capitalize">{e.action}</span></td>
                  <td className={tdClass}>{e.target_email || "—"}</td>
                  <td className={tdClass}>{e.actor_email || (e.action === "signup" ? "self" : "—")}</td>
                  <td className={cn(tdClass, "text-[12px] text-foreground/80")}>{describeAudit(e)}</td>
                </>
              )}
            />
          </div>
        </TabsContent>

        {/* ── IMPERSONATION ── */}
        <TabsContent value="impersonation">
          <div className={cardClass}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-bold text-foreground">Impersonation Log</span>
              <Button variant="secondary" size="sm" onClick={loadImp}>Refresh</Button>
            </div>
            <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
              <FilterInput label="Admin (actor email)" value={impAdmin} onChange={setImpAdmin} placeholder="jane@mymint.co.za" />
              <FilterInput label="Client email" value={impClient} onChange={setImpClient} placeholder="client@example.com" />
              <FilterInput label="From" value={impFrom} onChange={setImpFrom} type="date" />
              <FilterInput label="To" value={impTo} onChange={setImpTo} type="date" />
              <div className="flex gap-2">
                <Button size="sm" onClick={loadImp}>Apply</Button>
                <Button variant="secondary" size="sm" onClick={() => { setImpAdmin(""); setImpClient(""); setImpFrom(""); setImpTo(""); setTimeout(loadImp, 0); }}>Clear</Button>
              </div>
            </div>
            {impNotice && <div className="m-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground/80">{impNotice}</div>}
            <AuditTable entries={imp} cols={["When", "Admin (viewed as)", "Client", "Environment", "Details"]}
              render={(e) => {
                const d = e.details || {};
                const env = String(d.mint_environment || "").toLowerCase();
                return (
                  <>
                    <td className={tdClass}><span className="text-[11px] text-muted-foreground">{fmtWhen(e.created_at)}</span></td>
                    <td className={tdClass}>{e.actor_email || "—"}</td>
                    <td className={tdClass}>
                      <div>{e.target_email || "—"}</div>
                      {d.target_name ? <div className="text-[11px] text-muted-foreground">{String(d.target_name)}</div> : null}
                    </td>
                    <td className={tdClass}>{env ? <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase", env === "live" ? "bg-destructive/15 text-destructive" : "bg-info/15 text-info")}>{env}</span> : "—"}</td>
                    <td className={cn(tdClass, "text-[12px] text-foreground/80")}>{String(d.mint_base || "")}</td>
                  </>
                );
              }}
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Invite modal ── */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite Team Member</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <FieldLabel label="Full Name"><Input value={invName} onChange={(e) => setInvName(e.target.value)} placeholder="Jane Smith" /></FieldLabel>
            <FieldLabel label="Email Address">
              <Input value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="jane@mymint.co.za" />
              <p className="mt-1 text-[11px] text-muted-foreground">Only @mymint.co.za addresses can be invited.</p>
            </FieldLabel>
            <FieldLabel label="Role">
              <Select value={invRole} onValueChange={setInvRole}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="staff">Staff — restricted access</SelectItem>
                <SelectItem value="admin">Admin — full access</SelectItem>
              </SelectContent></Select>
            </FieldLabel>
            {invRole === "staff" && <PageAccessGrid selected={invPages} onToggle={(k) => setInvPages((s) => toggleSet(s, k))} />}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button onClick={submitInvite} disabled={busy}>{busy ? "Sending…" : "Send Invite"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit role modal ── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Member Role</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <FieldLabel label="Role">
              <Select value={editRole} onValueChange={setEditRole}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="staff">Staff — restricted access</SelectItem>
                <SelectItem value="admin">Admin — full access</SelectItem>
              </SelectContent></Select>
            </FieldLabel>
            {editRole === "staff" && <PageAccessGrid selected={editPages} onToggle={(k) => setEditPages((s) => toggleSet(s, k))} />}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={busy}>{busy ? "Saving…" : "Save Changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Update email modal ── */}
      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Update Email Address</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <FieldLabel label="Current Email"><Input value={emailCurrent} disabled /></FieldLabel>
            <FieldLabel label="New @mymint.co.za Email"><Input value={emailNew} onChange={(e) => setEmailNew(e.target.value)} placeholder="name@mymint.co.za" /></FieldLabel>
            {emailErr && <div className="rounded-lg bg-destructive/15 px-3 py-2 text-sm text-destructive">{emailErr}</div>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEmailOpen(false)}>Cancel</Button>
            <Button onClick={submitEmail} disabled={busy}>{busy ? "Updating…" : "Update Email"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Permissions modal ── */}
      <Dialog open={permOpen} onOpenChange={setPermOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Security Permissions</DialogTitle>
            <p className="text-xs text-muted-foreground">{permEmail}</p>
          </DialogHeader>

          <div>
            <label className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Approver Tier</label>
            <div className="space-y-2">
              {[
                { v: "", label: "Staff", desc: "Lower-level — approval workflows enforced for sensitive actions" },
                { v: "master", label: "Master Approver ★", desc: "Can review and authorize all pending requests from lower-level staff" },
                { v: "dev", label: "Dev ◆", desc: "Full bypass of all permission checks" },
              ].map((opt) => (
                <label key={opt.v} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3", permTier === opt.v ? "border-primary bg-primary/5" : "border-border")}>
                  <input type="radio" name="permTier" checked={permTier === opt.v} onChange={() => onTierChange(opt.v)} className="mt-0.5 accent-primary" />
                  <div>
                    <div className="text-sm font-semibold text-foreground">{opt.label}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {PERMISSION_MATRIX.map((section) => {
              const open = accOpen.has(section.key);
              return (
                <div key={section.key} className="overflow-hidden rounded-xl border border-border">
                  <button type="button" onClick={() => setAccOpen((s) => toggleSet(s, section.key))}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-accent/40">
                    <span className="flex items-center gap-2.5"><span>{section.icon}</span>{section.label}</span>
                    <span className={cn("transition-transform", open && "rotate-180")}>▾</span>
                  </button>
                  {open && (
                    <div className="border-t border-border px-4">
                      {section.fields.map((field) => {
                        const val = isDev ? (field.type === "toggle" ? true : lastTristate(field)) : permValues[section.key]?.[field.key];
                        return (
                          <div key={field.key} className="flex items-center justify-between gap-4 border-b border-border/50 py-3 last:border-b-0">
                            <div className="min-w-0">
                              <div className="text-[13px] font-semibold text-foreground">{field.label}</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">{field.desc}</div>
                            </div>
                            <div className="shrink-0">
                              {field.type === "toggle" ? (
                                <Switch checked={!!val} disabled={isDev} onCheckedChange={(v) => setFieldVal(section.key, field.key, v)} />
                              ) : (
                                <div className="flex gap-1">
                                  {field.options!.map((opt) => {
                                    const active = String(val) === String(opt.value);
                                    const blocked = opt.value === false;
                                    return (
                                      <button key={String(opt.value)} type="button" disabled={isDev}
                                        onClick={() => setFieldVal(section.key, field.key, opt.value)}
                                        className={cn(
                                          "whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold transition",
                                          active && blocked ? "border-destructive/50 bg-destructive/15 text-destructive"
                                            : active ? "border-primary bg-primary text-primary-foreground"
                                            : "border-input text-muted-foreground hover:border-primary hover:text-primary",
                                          isDev && "cursor-not-allowed opacity-45",
                                        )}>
                                        {opt.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setPermOpen(false)}>Cancel</Button>
            <Button onClick={submitPerms} disabled={busy}>{busy ? "Saving…" : "Save Permissions"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Small components ──
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}
function TierBadge({ tier }: { tier: string | null }) {
  if (tier === "dev") return <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-bold text-warning">Dev ◆</span>;
  if (tier === "master") return <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-bold text-primary">Master ★</span>;
  return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">Staff</span>;
}
function RolePill({ role }: { role: string }) {
  return role === "admin"
    ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">Admin</span>
    : <span className="rounded-full bg-info/15 px-2 py-0.5 text-[11px] font-semibold text-info">Staff</span>;
}
function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] font-semibold text-foreground">{label}</label>
      {children}
    </div>
  );
}
function FilterInput({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-1">
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}
function PageAccessGrid({ selected, onToggle }: { selected: Set<string>; onToggle: (k: string) => void }) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] font-semibold text-foreground">Page Access</label>
      <div className="grid grid-cols-2 gap-2">
        {ALL_PAGES.map((p) => (
          <label key={p.key} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px]">
            <input type="checkbox" checked={selected.has(p.key)} onChange={() => onToggle(p.key)} className="h-4 w-4 accent-primary" />
            {p.label}
          </label>
        ))}
      </div>
    </div>
  );
}
function AuditTable({ entries, cols, render }: { entries: AuditEntry[] | null; cols: string[]; render: (e: AuditEntry) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">{cols.map((c) => <th key={c} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{c}</th>)}</tr>
        </thead>
        <tbody>
          {entries === null ? (
            <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</td></tr>
          ) : entries.length === 0 ? (
            <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-sm text-muted-foreground">No activity.</td></tr>
          ) : (
            entries.map((e) => <tr key={e.id} className="border-b border-border/40 last:border-b-0">{render(e)}</tr>)
          )}
        </tbody>
      </table>
    </div>
  );
}
function ApprovalCard({ a, canResolve, onResolve }: { a: Approval; canResolve: boolean; onResolve: (id: string, decision: "approved" | "rejected", notes: string) => void }) {
  const [notes, setNotes] = React.useState("");
  const isPending = a.status === "pending";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-primary">{APPROVAL_TYPE_LABELS[a.type] || a.type}</span>
          <span className="text-[11px] text-muted-foreground">Requested by <strong className="text-foreground/80">{a.requested_by_email}</strong> · {fmtWhen(a.created_at)}</span>
        </div>
        {!isPending && (
          <span className={cn("rounded-md px-2 py-0.5 text-[12px] font-semibold", a.status === "approved" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive")}>
            {a.status === "approved" ? "✓ Approved" : "✗ Rejected"}{a.reviewed_by_email ? ` by ${a.reviewed_by_email}` : ""}
          </span>
        )}
      </div>
      <pre className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground/80">{fmtPayload(a.payload)}</pre>
      {a.notes && <div className="mb-2 text-xs italic text-muted-foreground">&quot;{a.notes}&quot;</div>}
      {isPending && canResolve && (
        <div className="space-y-2">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Add a note (optional)…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          <div className="flex gap-2">
            <Button size="sm" variant="success" onClick={() => onResolve(a.id, "approved", notes)}>✓ Approve</Button>
            <Button size="sm" variant="destructive" onClick={() => onResolve(a.id, "rejected", notes)}>✗ Reject</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function toggleSet(s: Set<string>, k: string): Set<string> {
  const next = new Set(s);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
}
