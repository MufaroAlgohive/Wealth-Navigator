"use client";

/**
 * Research-trigger alert banner for the Cockpit.
 *
 * Surfaced above the masthead — per the OEM meeting (transcript 2026-07-13
 * L:879), "as soon as any of them are hit, we need to get an automated
 * e-mail or what you call, the system needs to flag it." The worker
 * (`workers/iress-ingest/src/alerts.ts`) compares approved research note
 * `triggers` to live IRESS prices every cycle and writes hits to
 * `alert_log_c`; this banner reads `/api/alerts` and lets the FM ack each
 * one inline.
 *
 * Polls every 30s; cache-tunes a 25s SWR so we don't hammer the BFF.
 * Renders nothing if the table is empty — the banner must not become
 * noise on a quiet morning.
 */

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Check, ExternalLink, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface AlertRow {
  id: string;
  note_id: string;
  symbol: string;
  trigger_kind: "buy_below" | "add_below" | "trim_above" | "sell_above" | "stop_loss";
  trigger_price: number;
  observed_price: number;
  breached_at: string;
  acknowledged_at: string | null;
  email_sent_at: string | null;
  email_to: string | null;
  note_company_name?: string | null;
  payload?: { note?: string | null; observed_at?: string | null } | null;
}

interface AlertsResponse {
  alerts: AlertRow[];
  count: number;
}

const TRIGGER_LABEL: Record<AlertRow["trigger_kind"], string> = {
  buy_below: "BUY BELOW",
  add_below: "ADD BELOW",
  trim_above: "TRIM ABOVE",
  sell_above: "SELL ABOVE",
  stop_loss: "STOP LOSS",
};

const TRIGGER_TONE: Record<AlertRow["trigger_kind"], "success" | "warning" | "destructive"> = {
  buy_below: "success",
  add_below: "success",
  trim_above: "warning",
  sell_above: "destructive",
  stop_loss: "destructive",
};

function fetchAlerts(): Promise<AlertsResponse> {
  return fetch("/api/alerts")
    .then(async (r) => {
      if (!r.ok) return { alerts: [], count: 0 };
      return (await r.json()) as AlertsResponse;
    })
    .catch(() => ({ alerts: [], count: 0 } as AlertsResponse));
}

async function ackAlert(id: string, by: string): Promise<void> {
  await fetch(`/api/alerts/${encodeURIComponent(id)}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ by }),
  }).catch(() => undefined);
}

function ageMinutes(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(diff / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AlertBanner(): React.ReactElement | null {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["alerts", "unacked"],
    queryFn: fetchAlerts,
    ...queryOpts,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const alerts = (data?.alerts ?? []).filter((a) => !a.acknowledged_at);
  const [openId, setOpenId] = React.useState<string | null>(null);

  // First render shows skeleton briefly so we don't flash an empty banner;
  // once data lands we either render the banner or null. The SSR case is
  // handled by React Query's initial render returning undefined.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["alerts", "unacked"] });
  }, [queryClient]);

  const onAck = React.useCallback(
    async (id: string) => {
      await ackAlert(id, "cockpit");
      void queryClient.invalidateQueries({ queryKey: ["alerts", "unacked"] });
    },
    [queryClient],
  );

  if (!mounted) return null;
  if (!data) return null;
  if (alerts.length === 0) return null;

  return (
    <div
      className="glass-panel relative overflow-hidden border-warning/40 bg-warning/5 px-4 py-3 md:px-5"
      data-testid="alert-banner"
    >
      <div className="pointer-events-none absolute -left-12 -top-12 h-32 w-32 rounded-full bg-warning/20 blur-3xl" />
      <div className="relative flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <h2 className="text-section leading-none">
              Trigger alerts · {alerts.length} open
            </h2>
            <span className="glass-inset px-2 py-0.5 text-caption font-mono">
              alert_log_c · institutional
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              className="h-7 gap-1.5 px-2 text-caption"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Link
              href="/oems/research"
              className="inline-flex items-center gap-1 text-caption text-primary hover:underline"
            >
              Research Library <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
        <ul className="divide-y divide-warning/20">
          {alerts.slice(0, 6).map((a) => {
            const tone = TRIGGER_TONE[a.trigger_kind];
            const toneCls =
              tone === "destructive"
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : tone === "warning"
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-success/40 bg-success/5 text-success";
            return (
              <li key={a.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-2">
                <div className="pt-0.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                      toneCls,
                    )}
                  >
                    {TRIGGER_LABEL[a.trigger_kind]}
                  </span>
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-sm font-semibold">{a.symbol}</span>
                    {a.note_company_name ? (
                      <span className="text-xs text-muted-foreground">{a.note_company_name}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      level {a.trigger_price.toFixed(2)} · last {a.observed_price.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>breached {ageMinutes(a.breached_at)}</span>
                    {a.email_sent_at ? (
                      <span className="text-success">
                        email sent · {a.email_to ?? "auto"}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">no email (webhook unset)</span>
                    )}
                  </div>
                  {openId === a.id && a.payload?.note ? (
                    <p className="mt-1 rounded border border-warning/30 bg-warning/5 px-2 py-1 text-[11px] text-muted-foreground">
                      {a.payload.note}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {a.payload?.note ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenId(openId === a.id ? null : a.id)}
                      className="h-7 px-2 text-caption"
                    >
                      {openId === a.id ? "Hide note" : "Note"}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onAck(a.id)}
                    className="h-7 gap-1 px-2 text-caption"
                  >
                    <Check className="h-3.5 w-3.5" /> Ack
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {alerts.length > 6 ? (
          <p className="text-caption text-muted-foreground">
            + {alerts.length - 6} more — see{" "}
            <Link href="/oems/research" className="text-primary hover:underline">
              Research Library
            </Link>
            .
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default AlertBanner;