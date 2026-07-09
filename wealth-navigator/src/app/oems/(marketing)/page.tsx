"use client";

/**
 * Marketing › Hub — the landing page under the Marketing space. Surfaces:
 *  - Today's Mint Mornings status (sent / not yet sent)
 *  - Recent email_logs (last 10) for at-a-glance campaign health
 *  - Quick-link cards into Mint Mornings, Emailers, Triggers
 *
 * Per Lonwabo's preference (EMAIL_APP_MODE=embedded), the Emailers surface
 * lives inside this hub — switching `EMAIL_APP_MODE=separate` is reserved for
 * a future split-out and is not yet wired.
 */

import {
  CheckCircle2,
  Clock,
  EyeOff,
  Mail,
  Megaphone,
  Send,
  Sunrise,
  TrendingUp,
  Webhook,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import * as React from "react";

import { GlassKpi, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

interface MintMorningStatus {
  ok: boolean;
  alreadySentToday: boolean;
  lastSend: { send_date: string; articles_sent: number; users_sent: number; created_at: string } | null;
  recent: Array<{ send_date: string; articles_sent: number; users_sent: number }>;
  notice?: string;
}

interface EmailLog {
  id: string;
  email_type: string;
  recipient: string;
  subject: string | null;
  status: string;
  created_at: string;
  error_message: string | null;
}

const MINT_MORNINGS_PATH = "/oems/marketing/mint-mornings" as Route;
const EMAILERS_PATH = "/oems/marketing/emailers" as Route;
const TRIGGERS_PATH = "/oems/marketing/triggers" as Route;

const EMAIL_TYPE_LABEL: Record<string, string> = {
  trade_confirmation: "Trade Confirmation",
  welcome: "Welcome",
  wallet_funded: "Wallet Funded",
  eft: "EFT",
  mint_mornings: "Mint Mornings",
  admin_invite: "Admin Invite",
  wallet_topup: "Wallet Top-up",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-ZA", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MarketingHubPage() {
  const [status, setStatus] = React.useState<MintMorningStatus | null>(null);
  const [logs, setLogs] = React.useState<EmailLog[] | null>(null);
  const [logsNotice, setLogsNotice] = React.useState<string | null>(null);
  const [dismissedCount, setDismissedCount] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const [mm, el, dismissed] = await Promise.all([
        fetch("/api/admin/mint-mornings?action=status")
          .then((r) => r.json())
          .catch(() => ({ ok: false })),
        fetch("/api/admin/email-logs?limit=10")
          .then((r) => r.json())
          .catch(() => [] as unknown),
        fetch("/api/admin/notifications")
          .then((r) => r.json())
          .catch(() => ({ ok: false }) as unknown),
      ]);
      setStatus(
        mm.ok
          ? {
              ok: true,
              alreadySentToday: !!mm.alreadySentToday,
              lastSend: mm.lastSend ?? null,
              recent: mm.recent ?? [],
              notice: mm.notice,
            }
          : {
              ok: true,
              alreadySentToday: false,
              lastSend: null,
              recent: [],
              notice: "mint_mornings_log unavailable",
            },
      );
      if (Array.isArray(el)) {
        setLogs(el.slice(0, 10));
        setLogsNotice(null);
      } else {
        setLogs([]);
        setLogsNotice("email_logs unavailable");
      }
      // The dismissed-notifications endpoint returns 401 for non-admins —
      // that's expected; we silently skip the hint rather than crashing.
      if (dismissed && typeof dismissed === "object" && dismissed.ok) {
        setDismissedCount(Number(dismissed.count ?? 0));
      } else {
        setDismissedCount(null);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const sentToday = status?.alreadySentToday ?? false;
  const last = status?.lastSend ?? null;
  const sentCount = logs?.filter((l) => l.status === "sent").length ?? 0;
  const failedCount = logs?.filter((l) => l.status !== "sent").length ?? 0;

  return (
    <PageCanvas>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-section flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" /> Marketing hub
          </h1>
          <p className="text-caption mt-1">
            Mint Mornings, Emailers, and Triggers live here. Dispatch is deferred to the email/backend phase.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dismissedCount !== null && dismissedCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
              title="Items you've hidden from the persistent action-items bar"
            >
              <EyeOff className="h-3 w-3" />
              {dismissedCount} hidden
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>

      {/* KPI strip */}
      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="glass-kpi">
          <p className="text-caption">Mint Mornings · today</p>
          <div
            className={cn(
              "mt-1.5 flex items-center gap-2 text-[15px] font-bold",
              sentToday ? "text-up" : "text-warning",
            )}
          >
            {sentToday ? (
              <>
                <CheckCircle2 className="h-4 w-4" /> Sent today
              </>
            ) : (
              <>
                <Clock className="h-4 w-4" /> Not yet sent today
              </>
            )}
          </div>
          {status?.notice && (
            <p className="text-[10.5px] text-muted-foreground mt-1 truncate" title={status.notice}>
              {status.notice}
            </p>
          )}
        </div>
        <GlassKpi
          label="Last Mint Mornings"
          value={last?.send_date ?? "—"}
          sub={last ? fmtTime(last.created_at) : "—"}
        />
        <GlassKpi
          label="Users reached (last send)"
          value={last ? String(last.users_sent) : "—"}
          sub={last ? `${last.articles_sent} articles` : undefined}
        />
        <GlassKpi
          label="Recent email sends"
          value={logs === null ? "—" : `${sentCount} sent`}
          sub={
            logs === null
              ? "loading…"
              : failedCount > 0
                ? `${failedCount} failed in last 10`
                : "last 10 · all sent"
          }
          accent={failedCount > 0 ? "negative" : "positive"}
        />
      </section>

      {/* Hub cards */}
      <section className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        <HubCard
          href={MINT_MORNINGS_PATH}
          icon={Sunrise}
          title="Mint Mornings"
          desc="Daily digest auto-sent at 07:00 SAST. Manual send + test send live here."
          badge={sentToday ? "sent today" : "pending"}
          badgeVariant={sentToday ? "default" : "warning"}
        />
        <HubCard
          href={EMAILERS_PATH}
          icon={Mail}
          title="Emailers & Campaigns"
          desc="Marketing campaigns, webhook-driven transactional triggers, and send logs."
          badge="embedded"
          badgeVariant="default"
        />
        <HubCard
          href={TRIGGERS_PATH}
          icon={Webhook}
          title="Triggers"
          desc="Webhook + emailer automation hub. Stub surface — full editor lives in Emailers."
          badge="stub"
          badgeVariant="default"
        />
      </section>

      {/* Recent email send logs */}
      <GlassSection
        title="Recent email sends"
        subtitle="Last 10 entries from email_logs (Supabase RETAIL)"
        endpoint="GET /api/admin/email-logs?limit=10"
        dataSource="supabase"
      >
        {logsNotice && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-foreground/80">
            {logsNotice}
          </div>
        )}
        {logs === null ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No email logs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <Th>When</Th>
                  <Th>Type</Th>
                  <Th>Recipient</Th>
                  <Th>Subject</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-border/40 last:border-b-0">
                    <Td className="whitespace-nowrap">{fmtTime(l.created_at)}</Td>
                    <Td>
                      <Badge variant="outline">{EMAIL_TYPE_LABEL[l.email_type] ?? l.email_type}</Badge>
                    </Td>
                    <Td className="truncate max-w-[200px]">{l.recipient}</Td>
                    <Td className="truncate max-w-[300px] text-muted-foreground">
                      {l.subject || (l.error_message ? `⚠ ${l.error_message}` : "—")}
                    </Td>
                    <Td>
                      <span
                        className={cn(
                          "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                          l.status === "sent"
                            ? "bg-success/15 text-success"
                            : "bg-destructive/15 text-destructive",
                        )}
                      >
                        {l.status}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <Link
            href={EMAILERS_PATH}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
          >
            Open Emailers &amp; Triggers
            <Send className="h-3 w-3" />
          </Link>
        </div>
      </GlassSection>

      {/* Recent Mint Mornings */}
      <GlassSection
        title="Recent Mint Mornings sends"
        subtitle="Last few entries from mint_mornings_log"
        endpoint="GET /api/admin/mint-mornings?action=status"
        dataSource="supabase"
        className="mt-5"
      >
        {status === null ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
        ) : !status.recent || status.recent.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No sends recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <Th>Date</Th>
                  <Th>Articles</Th>
                  <Th>Users reached</Th>
                </tr>
              </thead>
              <tbody>
                {status.recent.slice(0, 5).map((r, idx) => (
                  <tr key={`${r.send_date}-${idx}`} className="border-b border-border/40 last:border-b-0">
                    <Td>{r.send_date}</Td>
                    <Td>{r.articles_sent}</Td>
                    <Td>{r.users_sent}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3" /> 60s auto-refresh
          </span>
          <Link
            href={MINT_MORNINGS_PATH}
            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
          >
            Open Mint Mornings
            <Send className="h-3 w-3" />
          </Link>
        </div>
      </GlassSection>
    </PageCanvas>
  );
}

function HubCard({
  href,
  icon: Icon,
  title,
  desc,
  badge,
  badgeVariant = "default",
}: {
  href: Route;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  badge?: string;
  badgeVariant?: "default" | "warning";
}) {
  return (
    <Link
      href={href}
      className="group glass-panel flex flex-col gap-3 p-5 transition-colors hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Icon className="h-4.5 w-4.5" />
        </span>
        {badge && <Badge variant={badgeVariant === "warning" ? "warning" : "default"}>{badge}</Badge>}
      </div>
      <div>
        <h3 className="text-[15px] font-bold text-foreground">{title}</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">{desc}</p>
      </div>
      <span className="ml-auto text-[11px] font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100">
        Open →
      </span>
    </Link>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 align-middle text-[12px] text-foreground", className)}>{children}</td>;
}
