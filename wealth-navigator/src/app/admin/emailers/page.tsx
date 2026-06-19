"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy, Plus, Info, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

interface Trigger {
  id: string;
  name: string;
  table_name: string;
  event_type: "INSERT" | "UPDATE" | "DELETE";
  email_type: string;
  user_id_field: string | null;
  condition_field: string | null;
  condition_value: string | null;
  description: string | null;
  enabled: boolean;
}

interface EmailLog {
  id: string;
  email_type: string;
  recipient: string;
  subject: string | null;
  trigger_source: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

interface TriggerForm {
  id: string | null;
  name: string;
  table_name: string;
  event_type: "INSERT" | "UPDATE" | "DELETE";
  email_type: string;
  user_id_field: string;
  condition_field: string;
  condition_value: string;
  description: string;
  enabled: boolean;
}

const EVENT_VARIANT: Record<string, "success" | "warning" | "destructive"> = {
  INSERT: "success",
  UPDATE: "warning",
  DELETE: "destructive",
};
const EMAIL_LABELS: Record<string, string> = {
  trade_confirmation: "Trade Confirmation",
  welcome: "Welcome Email",
  wallet_funded: "Wallet Funded",
};
const EMAIL_TYPE_OPTS = [
  { v: "trade_confirmation", l: "Trade Confirmation" },
  { v: "welcome", l: "Welcome Email" },
  { v: "wallet_funded", l: "Wallet Funded" },
];
const LOG_TYPES = [
  { v: "all", l: "All types" },
  { v: "trade_confirmation", l: "Trade Confirmation" },
  { v: "eft", l: "EFT" },
  { v: "mint_mornings", l: "Mint Mornings" },
  { v: "welcome", l: "Welcome" },
  { v: "wallet_funded", l: "Wallet Funded" },
];
const TABLE_SUGGESTIONS = ["stock_holdings", "profiles", "wallet_transactions", "wallets", "transactions"];

const emptyForm = (): TriggerForm => ({
  id: null,
  name: "",
  table_name: "",
  event_type: "INSERT",
  email_type: "trade_confirmation",
  user_id_field: "user_id",
  condition_field: "",
  condition_value: "",
  description: "",
  enabled: true,
});

const cardClass = "rounded-2xl border border-border bg-card p-5";
const thClass = "px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground";
const tdClass = "px-3 py-2.5 align-middle text-xs text-foreground";

export default function EmailersPage() {
  const [tab, setTab] = React.useState("triggers");
  const [origin, setOrigin] = React.useState("");

  const [triggers, setTriggers] = React.useState<Trigger[] | null>(null);
  const [triggersError, setTriggersError] = React.useState<string | null>(null);

  const [logs, setLogs] = React.useState<EmailLog[] | null>(null);
  const [logsLoadedOnce, setLogsLoadedOnce] = React.useState(false);
  const [logType, setLogType] = React.useState("all");

  const [modalOpen, setModalOpen] = React.useState(false);
  const [form, setForm] = React.useState<TriggerForm>(emptyForm);
  const [saving, setSaving] = React.useState(false);

  const loadTriggers = React.useCallback(async () => {
    setTriggers(null);
    setTriggersError(null);
    try {
      const data = await fetch("/api/admin/webhooks").then((r) => r.json());
      if (Array.isArray(data)) setTriggers(data);
      else setTriggersError("Could not load triggers. Ensure email_webhook_triggers exists.");
    } catch (e) {
      setTriggersError((e as Error).message);
    }
  }, []);

  const loadLogs = React.useCallback(async () => {
    setLogs(null);
    try {
      const qs = logType !== "all" ? `&type=${encodeURIComponent(logType)}` : "";
      const data = await fetch(`/api/admin/email-logs?limit=100${qs}`).then((r) => r.json());
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      setLogs([]);
    }
  }, [logType]);

  React.useEffect(() => {
    setOrigin(window.location.origin);
    void loadTriggers();
  }, [loadTriggers]);

  React.useEffect(() => {
    if (tab === "logs") {
      setLogsLoadedOnce(true);
      void loadLogs();
    }
  }, [tab, loadLogs]);

  const copyUrl = async () => {
    const url = `${origin}/api/webhooks/supabase`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copied!");
    } catch {
      window.prompt("Copy this URL:", url);
    }
  };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await fetch(`/api/admin/webhooks?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setTriggers((ts) => ts?.map((t) => (t.id === id ? { ...t, enabled } : t)) ?? ts);
      toast.success(enabled ? "Trigger enabled" : "Trigger disabled");
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    }
  };

  const deleteTrigger = async (id: string) => {
    if (!window.confirm("Delete this trigger?")) return;
    try {
      await fetch(`/api/admin/webhooks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setTriggers((ts) => ts?.filter((t) => t.id !== id) ?? ts);
      toast.success("Trigger deleted");
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    }
  };

  const openAdd = () => {
    setForm(emptyForm());
    setModalOpen(true);
  };

  const openEdit = (t: Trigger) => {
    setForm({
      id: t.id,
      name: t.name || "",
      table_name: t.table_name || "",
      event_type: t.event_type || "INSERT",
      email_type: t.email_type || "trade_confirmation",
      user_id_field: t.user_id_field || "user_id",
      condition_field: t.condition_field || "",
      condition_value: t.condition_value || "",
      description: t.description || "",
      enabled: !!t.enabled,
    });
    setModalOpen(true);
  };

  const saveTrigger = async () => {
    const body = {
      name: form.name.trim(),
      table_name: form.table_name.trim(),
      event_type: form.event_type,
      email_type: form.email_type,
      user_id_field: form.user_id_field.trim() || "user_id",
      condition_field: form.condition_field.trim() || null,
      condition_value: form.condition_value.trim() || null,
      description: form.description.trim() || null,
      enabled: form.enabled,
    };
    if (!body.name || !body.table_name) {
      toast.error("Name and table are required");
      return;
    }
    setSaving(true);
    try {
      if (form.id) {
        await fetch(`/api/admin/webhooks?id=${encodeURIComponent(form.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await fetch("/api/admin/webhooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      setModalOpen(false);
      await loadTriggers();
      toast.success(form.id ? "Trigger updated" : "Trigger created");
    } catch (e) {
      toast.error("Failed: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="triggers">Webhook Triggers</TabsTrigger>
          <TabsTrigger value="logs">Send Logs</TabsTrigger>
        </TabsList>

        {/* ── TRIGGERS ── */}
        <TabsContent value="triggers" className="space-y-4">
          <div className={cardClass}>
            <h2 className="text-[15px] font-bold text-foreground">Supabase Webhook URL</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Copy this URL into Supabase → Database → Webhooks. Point it at the tables below and Mint will send
              emails on database events.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground/80">
                {origin ? `${origin}/api/webhooks/supabase` : "Loading…"}
              </code>
              <Button variant="secondary" onClick={copyUrl}>
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs text-foreground/80">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                In Supabase set the URL, choose tables (e.g. <code>stock_holdings</code>, <code>profiles</code>,{" "}
                <code>wallet_transactions</code>), select events, and add header{" "}
                <code>x-webhook-secret</code> matching <code>SUPABASE_WEBHOOK_SECRET</code>.
              </span>
            </div>
          </div>

          <div className={cardClass}>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-[15px] font-bold text-foreground">Configured Triggers</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Each maps a Supabase table event to an email type.</p>
              </div>
              <Button onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" /> Add trigger
              </Button>
            </div>

            {triggers === null && !triggersError ? (
              <p className="py-8 text-center text-xs text-muted-foreground">Loading triggers…</p>
            ) : triggersError ? (
              <p className="py-8 text-center text-xs text-muted-foreground">{triggersError}</p>
            ) : triggers && triggers.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">No triggers yet. Click “Add trigger”.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={thClass}>Name</th>
                      <th className={thClass}>Table</th>
                      <th className={thClass}>Event</th>
                      <th className={thClass}>Email Type</th>
                      <th className={thClass}>Enabled</th>
                      <th className={thClass} />
                    </tr>
                  </thead>
                  <tbody>
                    {triggers?.map((t) => (
                      <tr key={t.id} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                        <td className={tdClass}>
                          <div className="font-semibold">{t.name}</div>
                          {t.description && <div className="mt-0.5 text-[10.5px] text-muted-foreground">{t.description}</div>}
                          {t.condition_field && (
                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              if {t.condition_field} = {t.condition_value || ""}
                            </div>
                          )}
                        </td>
                        <td className={tdClass}>
                          <code className="font-mono text-[11px]">{t.table_name}</code>
                        </td>
                        <td className={tdClass}>
                          <Badge variant={EVENT_VARIANT[t.event_type] ?? "outline"}>{t.event_type}</Badge>
                        </td>
                        <td className={tdClass}>{EMAIL_LABELS[t.email_type] ?? t.email_type}</td>
                        <td className={tdClass}>
                          <Switch checked={t.enabled} onCheckedChange={(v) => toggleEnabled(t.id, v)} />
                        </td>
                        <td className={tdClass}>
                          <div className="flex gap-1.5">
                            <Button variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={() => openEdit(t)}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                              onClick={() => deleteTrigger(t.id)}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── LOGS ── */}
        <TabsContent value="logs" className="space-y-4">
          <div className={cn(cardClass, "flex flex-wrap items-center gap-3")}>
            <h2 className="flex-1 text-[15px] font-bold text-foreground">Email Send Logs</h2>
            <div className="w-44">
              <Select value={logType} onValueChange={setLogType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_TYPES.map((o) => (
                    <SelectItem key={o.v} value={o.v}>
                      {o.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="secondary" size="sm" onClick={loadLogs}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>

          <div className={cn(cardClass, "p-0")}>
            {!logsLoadedOnce || logs === null ? (
              <p className="py-10 text-center text-xs text-muted-foreground">Loading…</p>
            ) : logs.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">No logs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={thClass}>Time</th>
                      <th className={thClass}>Type</th>
                      <th className={thClass}>Recipient</th>
                      <th className={thClass}>Subject</th>
                      <th className={thClass}>Source</th>
                      <th className={thClass}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l) => (
                      <React.Fragment key={l.id}>
                        <tr className="border-b border-border/40">
                          <td className={cn(tdClass, "whitespace-nowrap")}>
                            {new Date(l.created_at).toLocaleString("en-ZA", {
                              day: "2-digit",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className={tdClass}>
                            <Badge variant="default">{l.email_type}</Badge>
                          </td>
                          <td className={tdClass}>{l.recipient}</td>
                          <td className={cn(tdClass, "max-w-[220px] truncate")}>{l.subject || "—"}</td>
                          <td className={tdClass}>{l.trigger_source || "—"}</td>
                          <td className={cn(tdClass, "font-semibold", l.status === "sent" ? "text-success" : "text-destructive")}>
                            {l.status}
                          </td>
                        </tr>
                        {l.error_message && (
                          <tr>
                            <td colSpan={6} className="px-3 pb-2 pt-0">
                              <div className="font-mono text-[10px] text-destructive">↳ {l.error_message}</div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Add/Edit modal ── */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Trigger" : "Add Trigger"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Trade confirmed → investor email"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Table">
                <Input
                  list="emailers-table-list"
                  value={form.table_name}
                  onChange={(e) => setForm((f) => ({ ...f, table_name: e.target.value }))}
                  placeholder="e.g. stock_holdings"
                />
                <datalist id="emailers-table-list">
                  {TABLE_SUGGESTIONS.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
              <Field label="Event">
                <Select value={form.event_type} onValueChange={(v) => setForm((f) => ({ ...f, event_type: v as TriggerForm["event_type"] }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["INSERT", "UPDATE", "DELETE"] as const).map((e) => (
                      <SelectItem key={e} value={e}>
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Email type">
                <Select value={form.email_type} onValueChange={(v) => setForm((f) => ({ ...f, email_type: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMAIL_TYPE_OPTS.map((o) => (
                      <SelectItem key={o.v} value={o.v}>
                        {o.l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="User ID field">
                <Input
                  value={form.user_id_field}
                  onChange={(e) => setForm((f) => ({ ...f, user_id_field: e.target.value }))}
                  placeholder="user_id"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Condition field (optional)">
                <Input
                  value={form.condition_field}
                  onChange={(e) => setForm((f) => ({ ...f, condition_field: e.target.value }))}
                  placeholder="e.g. status"
                />
              </Field>
              <Field label="Condition value">
                <Input
                  value={form.condition_value}
                  onChange={(e) => setForm((f) => ({ ...f, condition_value: e.target.value }))}
                  placeholder="e.g. confirmed"
                />
              </Field>
            </div>

            <Field label="Description (optional)">
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What does this trigger do?"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </Field>

            <div className="flex items-center gap-2 pt-1">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
              <span className="text-xs font-semibold text-foreground">Enabled</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveTrigger} disabled={saving}>
              {saving ? "Saving…" : "Save trigger"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
