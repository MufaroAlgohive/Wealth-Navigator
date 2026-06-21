"use client";

/**
 * Marketing Campaigns tab for /admin/emailers.
 *
 * DATA-DEFERRED: This is the real Marketing emailer UI, but everything that needs
 * the backend is honestly stubbed:
 *   - Campaigns live ONLY in component state. Persisting them to a DB wires in the
 *     data phase (no campaign API exists yet).
 *   - Recipient counts per audience, Sent/Opens stats render as "—" (deferred).
 *   - "Save draft", "Send test", "Schedule"/"Send" never actually send. The real
 *     Resend blast + scheduling wiring is the data phase — these only update local
 *     state to the right status and surface a toast saying so.
 * Distinct from the transactional Webhook Triggers tab (DB-event emails).
 */

import * as React from "react";
import { toast } from "sonner";
import { Plus, Send, Save, FlaskConical, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

type CampaignStatus = "draft" | "scheduled" | "sent";

interface Campaign {
  id: string;
  name: string;
  subject: string;
  audience: string;
  body: string;
  fromAddress: string;
  status: CampaignStatus;
  /** ISO datetime-local string when status === "scheduled"; null otherwise. */
  scheduledFor: string | null;
  updatedAt: string;
}

interface CampaignForm {
  id: string | null;
  name: string;
  subject: string;
  audience: string;
  body: string;
  fromAddress: string;
  sendMode: "now" | "schedule";
  scheduledFor: string;
}

const DEFAULT_FROM = "noreply@mymint.co.za";

const AUDIENCES = [
  { v: "all", l: "All investors" },
  { v: "kyc", l: "KYC-verified clients" },
  { v: "strategy", l: "By strategy" },
  { v: "custom", l: "Custom list" },
] as const;

const AUDIENCE_LABELS: Record<string, string> = Object.fromEntries(AUDIENCES.map((a) => [a.v, a.l]));

const STATUS_FILTERS = [
  { v: "all", l: "All campaigns" },
  { v: "draft", l: "Draft" },
  { v: "scheduled", l: "Scheduled" },
  { v: "sent", l: "Sent" },
] as const;

const STATUS_BADGE: Record<CampaignStatus, { variant: "ghost" | "warning" | "success"; label: string }> = {
  draft: { variant: "ghost", label: "Draft" },
  scheduled: { variant: "warning", label: "Scheduled" },
  sent: { variant: "success", label: "Sent" },
};

const cardClass = "rounded-2xl border border-border bg-card p-5";
const thClass = "px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground";
const tdClass = "px-3 py-2.5 align-middle text-xs text-foreground";

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;

const emptyForm = (): CampaignForm => ({
  id: null,
  name: "",
  subject: "",
  audience: "all",
  body: "",
  fromAddress: DEFAULT_FROM,
  sendMode: "now",
  scheduledFor: "",
});

function formatUpdated(iso: string): string {
  return new Date(iso).toLocaleString("en-ZA", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EmailerCampaigns() {
  // Campaigns persist only in component state — DB persistence wires in the data phase.
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<string>("all");

  const [modalOpen, setModalOpen] = React.useState(false);
  const [form, setForm] = React.useState<CampaignForm>(emptyForm);

  const openNew = () => {
    setForm(emptyForm());
    setModalOpen(true);
  };

  const openEdit = (c: Campaign) => {
    setForm({
      id: c.id,
      name: c.name,
      subject: c.subject,
      audience: c.audience,
      body: c.body,
      fromAddress: c.fromAddress,
      sendMode: c.status === "scheduled" ? "schedule" : "now",
      scheduledFor: c.scheduledFor ?? "",
    });
    setModalOpen(true);
  };

  /** Validate the minimum a campaign needs before any deferred action. */
  const validate = (): boolean => {
    if (!form.name.trim()) {
      toast.error("Campaign name is required");
      return false;
    }
    if (!form.subject.trim()) {
      toast.error("Subject line is required");
      return false;
    }
    return true;
  };

  /** Upsert the form into local state with the given status, then close + toast. */
  const commit = (status: CampaignStatus, toastMsg: string) => {
    const scheduledFor = status === "scheduled" ? form.scheduledFor || null : null;
    setCampaigns((prev) => {
      const base: Omit<Campaign, "id"> = {
        name: form.name.trim(),
        subject: form.subject.trim(),
        audience: form.audience,
        body: form.body,
        fromAddress: form.fromAddress.trim() || DEFAULT_FROM,
        status,
        scheduledFor,
        updatedAt: new Date().toISOString(),
      };
      if (form.id) {
        return prev.map((c) => (c.id === form.id ? { ...c, ...base } : c));
      }
      return [{ id: newId(), ...base }, ...prev];
    });
    setModalOpen(false);
    toast.message(toastMsg, { description: "Persistence + real send wire in the data phase." });
  };

  const onSaveDraft = () => {
    if (!validate()) return;
    commit("draft", "Draft saved (deferred to the data phase)");
  };

  const onSendTest = () => {
    if (!validate()) return;
    // Deferred: real test send goes through Resend in the data phase. Keep current status.
    toast.message("Test send (deferred to the Resend/data phase)", {
      description: `A test would send from ${form.fromAddress.trim() || DEFAULT_FROM}. The test-recipient picker wires in the data phase.`,
    });
  };

  const onSchedule = () => {
    if (!validate()) return;
    if (form.sendMode === "schedule") {
      if (!form.scheduledFor) {
        toast.error("Pick a date & time to schedule");
        return;
      }
      const when = new Date(form.scheduledFor).getTime();
      if (Number.isNaN(when)) {
        toast.error("That schedule date & time isn't valid");
        return;
      }
      if (when <= Date.now()) {
        toast.error("Pick a schedule time in the future");
        return;
      }
      commit("scheduled", "Scheduled (deferred to the Resend/data phase)");
    } else {
      commit("sent", "Send queued (deferred to the Resend/data phase)");
    }
  };

  const filtered = campaigns.filter((c) => statusFilter === "all" || c.status === statusFilter);

  return (
    <div className="space-y-4">
      {/* ── Audiences sub-panel (recipient counts deferred → "—") ── */}
      <div className={cardClass}>
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <h2 className="text-[15px] font-bold text-foreground">Audiences</h2>
          <span className="text-[11px] text-muted-foreground">Recipient counts wire in the data phase.</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {AUDIENCES.map((a) => (
            <div key={a.v} className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
              <div className="text-xs font-semibold text-foreground">{a.l}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                <span className="font-mono text-sm text-foreground/70">—</span> recipients
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Campaigns list ── */}
      <div className={cardClass}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-bold text-foreground">Marketing Campaigns</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Build and schedule email blasts for the Marketing team. Separate from transactional triggers.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-40">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((o) => (
                    <SelectItem key={o.v} value={o.v}>
                      {o.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={openNew}>
              <Plus className="h-3.5 w-3.5" /> New campaign
            </Button>
          </div>
        </div>

        {campaigns.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">No campaigns yet — create one.</p>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">No campaigns match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Name</th>
                  <th className={thClass}>Audience</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Recipients</th>
                  <th className={thClass}>Sent / Opens</th>
                  <th className={thClass}>Updated</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const badge = STATUS_BADGE[c.status];
                  return (
                    <tr key={c.id} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                      <td className={tdClass}>
                        <div className="font-semibold">{c.name}</div>
                        <div className="mt-0.5 max-w-[260px] truncate text-[10.5px] text-muted-foreground">{c.subject}</div>
                        {c.status === "scheduled" && c.scheduledFor && (
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            for {formatUpdated(c.scheduledFor)}
                          </div>
                        )}
                      </td>
                      <td className={tdClass}>{AUDIENCE_LABELS[c.audience] ?? c.audience}</td>
                      <td className={tdClass}>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      {/* Deferred — no recipient resolution yet. */}
                      <td className={cn(tdClass, "font-mono text-muted-foreground")}>—</td>
                      {/* Deferred — send/open stats come from Resend in the data phase. */}
                      <td className={cn(tdClass, "font-mono text-muted-foreground")}>—</td>
                      <td className={cn(tdClass, "whitespace-nowrap text-muted-foreground")}>{formatUpdated(c.updatedAt)}</td>
                      <td className={tdClass}>
                        <Button variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={() => openEdit(c)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Compose dialog ── */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Campaign" : "New Campaign"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <Field label="Campaign name">
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. June market update"
              />
            </Field>

            <Field label="Subject line">
              <Input
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                placeholder="What investors see in their inbox"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Audience segment">
                <Select value={form.audience} onValueChange={(v) => setForm((f) => ({ ...f, audience: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map((a) => (
                      <SelectItem key={a.v} value={a.v}>
                        {a.l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="From address">
                <Input
                  value={form.fromAddress}
                  onChange={(e) => setForm((f) => ({ ...f, fromAddress: e.target.value }))}
                  placeholder={DEFAULT_FROM}
                />
              </Field>
            </div>

            <Field label="Email body">
              <textarea
                rows={6}
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder={"Write your email — simple markdown is fine.\n\nHi {{first_name}}, …"}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </Field>

            <Field label="Schedule">
              <div className="space-y-2">
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {(["now", "schedule"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, sendMode: mode }))}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                        form.sendMode === mode
                          ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {mode === "now" ? "Send now" : "Schedule"}
                    </button>
                  ))}
                </div>
                {form.sendMode === "schedule" && (
                  <Input
                    type="datetime-local"
                    value={form.scheduledFor}
                    onChange={(e) => setForm((f) => ({ ...f, scheduledFor: e.target.value }))}
                  />
                )}
              </div>
            </Field>

            <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-foreground/80">
              Sending is deferred — actions save the campaign locally and surface a notice. Real Resend blasts,
              scheduling, and persistence wire in the data phase.
            </p>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={onSaveDraft}>
              <Save className="h-3.5 w-3.5" /> Save draft
            </Button>
            <Button variant="secondary" onClick={onSendTest}>
              <FlaskConical className="h-3.5 w-3.5" /> Send test
            </Button>
            <Button onClick={onSchedule}>
              <Send className="h-3.5 w-3.5" /> {form.sendMode === "schedule" ? "Schedule" : "Send"}
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
