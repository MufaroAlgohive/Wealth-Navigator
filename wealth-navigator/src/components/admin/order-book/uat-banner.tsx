"use client";

/**
 * UatBanner — yellow "UAT MODE" banner shown at the top of the Order Book
 * page when the Railway worker reports UAT mode is on.
 *
 * Pulls `/api/admin/orderbook/uat-status` once on mount and shows:
 *  - whether Vercel UAT mode is on (IRESS_UAT_MODE=true)
 *  - whether the worker is configured (IRESS_WORKER_URL set)
 *  - the worker's UAT account code
 *  - the last UAT order-pad poll timestamp (worker /uat/status.lastPollAt)
 *  - the poll interval in seconds
 *
 * Renders nothing when UAT mode is off so production stays visually
 * unchanged. The banner is intentionally non-blocking — the desk can still
 * run the existing audit-only flow when the worker is unreachable.
 */

import { AlertTriangle, Radio } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

interface UatStatus {
  ok: boolean;
  uat_mode: boolean;
  worker_configured: boolean;
  worker_uat_mode: boolean | null;
  last_poll_at: string | null;
  poll_interval_sec: number | null;
  worker_id: string | null;
  account_code: string | null;
  iress_mode: string | null;
  notice: string | null;
}

const POLL_INTERVAL_MS = 30_000;

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const delta = Date.now() - t;
  if (delta < 0) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function UatBanner({ className }: { className?: string }) {
  const [status, setStatus] = React.useState<UatStatus | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/orderbook/uat-status", { cache: "no-store" });
      const body = (await res.json()) as UatStatus;
      setStatus(body);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) return null;
  if (!status?.uat_mode) return null; // Production — no banner.

  const workerReady = status.worker_configured && status.worker_uat_mode === true;
  const lastPollDeltaSec = status.last_poll_at
    ? Math.floor((Date.now() - Date.parse(status.last_poll_at)) / 1000)
    : null;
  const pollStale =
    lastPollDeltaSec != null &&
    status.poll_interval_sec != null &&
    lastPollDeltaSec > status.poll_interval_sec * 3;

  return (
    <output
      className={cn(
        "rounded-md border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12px] text-warning",
        "flex flex-wrap items-center gap-3",
        className,
      )}
      aria-live="polite"
    >
      <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider">
        <AlertTriangle className="h-3.5 w-3.5" />
        UAT Mode
      </span>
      <span className="text-foreground/80">
        Orders will execute against the MINT_CT IOS UAT account. No real client money at risk.
      </span>
      {status.account_code ? (
        <Badge variant="outline" className="font-mono text-[10px]">
          UAT acct: {status.account_code}
        </Badge>
      ) : (
        <Badge variant="destructive" className="font-mono text-[10px]">
          UAT account not configured
        </Badge>
      )}
      {status.iress_mode ? (
        <Badge variant="outline" className="font-mono text-[10px]">
          {status.iress_mode}
        </Badge>
      ) : null}
      {workerReady ? (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[10px] uppercase tracking-wider",
            pollStale ? "text-destructive" : "text-success",
          )}
        >
          <Radio className="h-3 w-3" />
          last poll {fmtRelative(status.last_poll_at)}
          {status.poll_interval_sec ? ` · ${status.poll_interval_sec}s interval` : ""}
        </span>
      ) : (
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          worker not in UAT mode — audit-only fallback active
        </span>
      )}
      {status.notice ? <span className="text-[10px] text-muted-foreground">· {status.notice}</span> : null}
    </output>
  );
}

export default UatBanner;
