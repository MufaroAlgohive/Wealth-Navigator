"use client";

/**
 * Marketing › Mint Mornings — daily digest sender. The previous
 * `/admin/mint-mornings` page was redirected to `/oems/marketing/mint-mornings`
 * (Mint OEM finalisation Phase A1) and replaced here so the marketing hub
 * owns the live surface.
 *
 * Source BFF: GET `/api/admin/mint-mornings?action=status` reads
 * `mint_mornings_log` and tells us whether today's digest has been sent.
 * The actual send/test/force POSTs return 501 (deferred to the email/backend
 * phase) — the controls are visible but disabled so staff understand where
 * the wiring lands.
 */

import { CheckCircle2, Clock, Sunrise } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

interface LogRow {
  id: string;
  send_date: string;
  articles_sent: number;
  users_sent: number;
  created_at: string;
}

const card = "rounded-xl border border-border bg-card p-5";
const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "—";

export default function MintMorningsPage() {
  const [status, setStatus] = React.useState<{
    alreadySentToday: boolean;
    lastSend: LogRow | null;
    recent: LogRow[];
    notice?: string;
  } | null>(null);
  const [testEmail, setTestEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setStatus(null);
    const d = await fetch("/api/admin/mint-mornings?action=status")
      .then((r) => r.json())
      .catch(() => ({ ok: false }));
    setStatus(
      d.ok
        ? {
            alreadySentToday: d.alreadySentToday,
            lastSend: d.lastSend,
            recent: d.recent || [],
            notice: d.notice,
          }
        : { alreadySentToday: false, lastSend: null, recent: [] },
    );
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const post = async (qs: string, label: string) => {
    setBusy(true);
    try {
      const d = await fetch(`/api/admin/mint-mornings${qs}`, { method: "POST" })
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
      toast.message(d.error || (d.ok ? `${label} ok` : "Deferred"));
    } finally {
      setBusy(false);
    }
  };
  const loadPreview = async () => {
    const d = await fetch("/api/admin/mint-mornings?action=preview")
      .then((r) => r.json())
      .catch(() => ({ ok: false }));
    toast.message(d.notice || "Preview loaded");
  };

  const last = status?.lastSend ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* Schedule banner */}
      <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground/80">
        <Sunrise className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          Auto-sends daily at <strong>07:00 SAST</strong> from the latest ALLBRF (News_articles) digest.
        </span>
      </div>

      {/* Status */}
      <div className={cn(card, "flex items-center justify-between")}>
        <div className="flex items-center gap-3">
          {status?.alreadySentToday ? (
            <CheckCircle2 className="h-6 w-6 text-success" />
          ) : (
            <Clock className="h-6 w-6 text-warning" />
          )}
          <div>
            <div className="text-sm font-bold text-foreground">
              {status === null ? "Loading…" : status.alreadySentToday ? "Sent today ✓" : "Not yet sent today"}
            </div>
            {status?.notice && <div className="text-[11px] text-muted-foreground">{status.notice}</div>}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Last send" value={last?.send_date ?? "—"} />
        <Kpi label="Articles sent" value={last ? String(last.articles_sent) : "—"} />
        <Kpi label="Users reached" value={last ? String(last.users_sent) : "—"} />
        <Kpi label="Sent at" value={last ? fmtTime(last.created_at) : "—"} />
      </div>

      {/* Manual send + test */}
      <div className={card}>
        <h2 className="text-[15px] font-bold text-foreground">Manual send</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Dispatch is deferred to the email/backend phase — controls are wired and will activate then.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => post("", "Send")}>
            Send today&apos;s edition
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => post("?force=true", "Re-send")}>
            Re-send (force)
          </Button>
          <Button variant="secondary" disabled={busy} onClick={loadPreview}>
            Load preview
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label
              htmlFor="mint-mornings-test-email"
              className="mb-1 block text-[12px] font-semibold text-foreground"
            >
              Test send
            </label>
            <Input
              id="mint-mornings-test-email"
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="you@mymint.co.za"
            />
          </div>
          <Button
            variant="secondary"
            disabled={busy || !testEmail.includes("@")}
            onClick={() => post(`?test=${encodeURIComponent(testEmail)}`, "Test send")}
          >
            Send test
          </Button>
        </div>
      </div>

      {/* History */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Date
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Articles
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Users
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Sent at
              </th>
            </tr>
          </thead>
          <tbody>
            {status === null ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : status.recent.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No sends recorded yet.
                </td>
              </tr>
            ) : (
              status.recent.map((r) => (
                <tr key={r.id} className="border-b border-border/40 last:border-b-0">
                  <td className="px-4 py-3 text-[13px] text-foreground">{r.send_date}</td>
                  <td className="px-4 py-3 text-[13px] text-foreground">{r.articles_sent}</td>
                  <td className="px-4 py-3 text-[13px] text-foreground">{r.users_sent}</td>
                  <td className="px-4 py-3 text-[13px] text-foreground">{fmtTime(r.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-base font-bold text-foreground">{value}</div>
    </div>
  );
}
