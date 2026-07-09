"use client";

/**
 * ActionItemsBar — persistent strip across the top of the platform shell
 * that surfaces pending work drawn from `/api/admin/action-items`.
 *
 * Behaviour:
 *   - Renders nothing when the count is zero OR when the user is not
 *     authenticated as an admin team member (the BFF returns 401 → we
 *     silently hide the strip so non-admins never see a "0 pending" bar).
 *   - Polls every 30s with conditional requests (ETag) so an empty queue
 *     costs nothing.
 *   - Expands into a dropdown listing each item with severity colouring
 *     and a per-item deep-link.
 *   - Honours `prefers-reduced-motion` — the pulse falls back to a
 *     static, brighter accent.
 *   - Per-item dismiss button (`x`) writes to `/api/admin/action-items/dismiss`
 *     and optimistically removes the item from the local view. The BFF
 *     filters out dismissed ids on the next poll too, so the bar stays
 *     in sync across navigations and polls.
 *
 * Sticky placement: `<PlatformShell />` mounts this right below the
 * dev-mock banner so it sits between the masthead and the page body on
 * every authenticated route.
 */

import {
  AlertTriangle,
  Banknote,
  BellRing,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  ClipboardCheck,
  Coins,
  Loader2,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { useAdmin } from "@/lib/admin/context";
import { cn } from "@/lib/cn";

type ActionItemSeverity = "info" | "warning" | "critical";
type ActionItemType = "admin_approval" | "eft_pending" | "rebalance_ready" | "manual_funds" | "mm_topup";

interface ActionItem {
  id: string;
  type: ActionItemType;
  label: string;
  href: string;
  severity: ActionItemSeverity;
  createdAt: string;
}

interface ActionItemsPayload {
  ok: boolean;
  count: number;
  total?: number;
  items: ActionItem[];
}

interface FetchState {
  ok: boolean;
  count: number;
  items: ActionItem[];
  status: "idle" | "loading" | "ready" | "unauth" | "error";
  error?: string;
}

const INITIAL: FetchState = { ok: false, count: 0, items: [], status: "idle" };

const SEVERITY_RANK: Record<ActionItemSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function severityClasses(sev: ActionItemSeverity): { bg: string; ring: string; text: string; bar: string } {
  switch (sev) {
    case "critical":
      return {
        bg: "bg-destructive/10",
        ring: "ring-destructive/40",
        text: "text-destructive",
        bar: "bg-destructive",
      };
    case "warning":
      return {
        bg: "bg-warning/10",
        ring: "ring-warning/40",
        text: "text-warning",
        bar: "bg-warning",
      };
    default:
      return {
        bg: "bg-info/10",
        ring: "ring-info/40",
        text: "text-info",
        bar: "bg-info",
      };
  }
}

const ICON_FOR_TYPE: Record<ActionItemType, React.ComponentType<{ className?: string }>> = {
  admin_approval: ClipboardCheck,
  eft_pending: Coins,
  rebalance_ready: CircleAlert,
  manual_funds: Banknote,
  mm_topup: Banknote,
};

export function ActionItemsBar() {
  const { ctx } = useAdmin();
  const [state, setState] = React.useState<FetchState>(INITIAL);
  const [open, setOpen] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  // Optimistic dismissals — items removed locally before the next poll
  // confirms the server. Reset on route change (BFF stays canonical).
  const [optimisticDismissed, setOptimisticDismissed] = React.useState<Set<string>>(new Set());
  const [dismissingKey, setDismissingKey] = React.useState<string | null>(null);

  // Only show the bar to admin team members. The BFF returns 401 for
  // everyone else; we keep that contract and hide the strip here.
  const isAdmin = ctx.role === "admin" || ctx.role === "superadmin" || ctx.approverTier === "dev";

  // Respect prefers-reduced-motion.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Polling loop with ETag-aware conditional requests.
  const etagRef = React.useRef<string | null>(null);
  const cancelledRef = React.useRef(false);

  const fetchItems = React.useCallback(async () => {
    if (cancelledRef.current) return;
    const headers: Record<string, string> = {};
    if (etagRef.current) headers["If-None-Match"] = etagRef.current;
    let res: Response;
    try {
      res = await fetch("/api/admin/action-items", { headers, cache: "no-store" });
    } catch (e) {
      setState((prev) => ({ ...prev, status: "error", error: (e as Error).message }));
      return;
    }
    if (res.status === 304) return; // unchanged
    if (res.status === 401 || res.status === 403) {
      setState({ ok: false, count: 0, items: [], status: "unauth" });
      return;
    }
    if (!res.ok) {
      setState((prev) => ({ ...prev, status: "error", error: `HTTP ${res.status}` }));
      return;
    }
    const newEtag = res.headers.get("etag");
    if (newEtag) etagRef.current = newEtag;
    const body = (await res.json()) as ActionItemsPayload;
    if (!body.ok) {
      setState((prev) => ({ ...prev, status: "error", error: "ok=false from API" }));
      return;
    }
    // Server already filters out dismissed items, but the optimistic set
    // may contain ids the server hasn't acknowledged yet — apply that
    // locally too.
    const filtered = body.items.filter((it) => !optimisticDismissed.has(`${it.type}:${it.id}`));
    setState({
      ok: true,
      count: filtered.length,
      items: filtered,
      status: "ready",
    });
  }, [optimisticDismissed]);

  React.useEffect(() => {
    if (!isAdmin) {
      setState(INITIAL);
      return;
    }
    cancelledRef.current = false;
    void fetchItems();
    const id = window.setInterval(() => void fetchItems(), 30_000);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
  }, [isAdmin, fetchItems]);

  // Dismiss handler — optimistic removal + BFF write + audit log.
  const dismiss = React.useCallback(
    async (item: ActionItem) => {
      const key = `${item.type}:${item.id}`;
      if (dismissingKey) return;
      setDismissingKey(key);
      setOptimisticDismissed((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setState((prev) => ({
        ...prev,
        items: prev.items.filter((it) => `${it.type}:${it.id}` !== key),
        count: Math.max(0, prev.count - 1),
      }));
      try {
        const res = await fetch("/api/admin/action-items/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, type: item.type }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const body = (await res.json().catch(() => null)) as { dismissed?: boolean; notice?: string } | null;
        if (body?.notice) {
          toast.message("Dismiss recorded locally only", { description: body.notice });
        }
      } catch (e) {
        // Roll back the optimistic removal so the bar reflects reality.
        setOptimisticDismissed((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        toast.error("Could not dismiss", { description: (e as Error).message });
        void fetchItems();
      } finally {
        setDismissingKey(null);
      }
    },
    [dismissingKey, fetchItems],
  );

  // Close the popover on Escape + outside click.
  const rootRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [open]);

  if (!isAdmin) return null;
  if (state.status === "unauth") return null;
  if (state.status !== "ready" && state.status !== "error") {
    // Initial-load placeholder while the first 401-guarded poll is in flight.
    return null;
  }
  if (state.count === 0) return null;

  // Sort items so the most-urgent float to the top (BFF already sorts, but
  // belt + braces in case a future caller passes them out of order).
  const items = [...state.items].sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const summaryLabel = summarise(items);

  return (
    <section
      ref={rootRef}
      className={cn(
        "relative border-b border-primary/30",
        "bg-[hsl(var(--primary)/0.08)]",
        "backdrop-blur-md",
        reducedMotion ? "" : "animate-pulse",
      )}
      aria-label="Pending action items"
    >
      <div className="mx-auto flex w-full max-w-[1800px] items-center gap-3 px-4 py-2 md:px-5">
        <div className="flex items-center gap-2 text-primary">
          <BellRing className="h-4 w-4" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wider">Action items</span>
        </div>

        <Badge variant="default" className="font-mono">
          {state.count}
        </Badge>

        <span className="hidden text-[12px] text-foreground/80 md:inline">{summaryLabel}</span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="action-items-panel"
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wider",
              "text-foreground/80 hover:bg-primary/10 hover:text-foreground",
              "transition-colors",
            )}
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {open ? "Hide" : "Review"}
          </button>
        </div>
      </div>

      {open && (
        <div
          id="action-items-panel"
          className={cn(
            "absolute right-3 top-full z-40 mt-1 w-[min(460px,calc(100vw-1.5rem))]",
            "glass-panel rounded-xl p-0 shadow-2xl",
          )}
        >
          <div className="flex items-center justify-between border-b border-[hsl(var(--glass-border))] px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-primary" /> Pending work
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Dismissed = hidden, not resolved
              </span>
              <Badge variant="default" className="font-mono">
                {state.count}
              </Badge>
            </div>
          </div>

          <ul className="max-h-[60vh] overflow-y-auto scrollbar-thin">
            {items.map((item) => {
              const cls = severityClasses(item.severity);
              const Icon = ICON_FOR_TYPE[item.type] ?? CircleAlert;
              const key = `${item.type}:${item.id}`;
              return (
                <li key={key}>
                  <div
                    className={cn(
                      "group flex items-start gap-3 px-3 py-2 text-[12px] transition-colors",
                      "hover:bg-foreground/5",
                    )}
                  >
                    <a href={item.href} className="flex min-w-0 flex-1 items-start gap-3">
                      <span
                        className={cn(
                          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1",
                          cls.bg,
                          cls.ring,
                          cls.text,
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground">{item.label}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                          <span className={cn("h-1.5 w-1.5 rounded-full", cls.bar)} />
                          {item.severity}
                          <span aria-hidden>·</span>
                          <time dateTime={item.createdAt}>{relativeAge(item.createdAt)}</time>
                        </span>
                      </span>
                    </a>
                    <button
                      type="button"
                      onClick={() => void dismiss(item)}
                      disabled={dismissingKey === key}
                      aria-label={`Dismiss ${item.label}`}
                      className={cn(
                        "ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                        "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
                        "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                        dismissingKey === key && "opacity-100",
                      )}
                    >
                      {dismissingKey === key ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {state.status === "error" && (
            <div className="flex items-center gap-2 border-t border-[hsl(var(--glass-border))] px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Could not refresh — {state.error ?? "unknown error"}. Will retry in 30s.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function summarise(items: ActionItem[]): string {
  const counts: Record<ActionItemSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const it of items) counts[it.severity]++;
  const bits: string[] = [];
  if (counts.critical) bits.push(`${counts.critical} EFT pending`);
  if (counts.warning) {
    const manual = items.filter((it) => it.type === "manual_funds").length;
    const approvals = counts.warning - manual;
    if (approvals) bits.push(`${approvals} approval${approvals > 1 ? "s" : ""}`);
    if (manual) bits.push(`${manual} manual funds`);
  }
  if (counts.info) {
    const rebal = items.filter((it) => it.type === "rebalance_ready").length;
    const mm = items.filter((it) => it.type === "mm_topup").length;
    if (rebal) bits.push(`${rebal} rebalance${rebal > 1 ? "s" : ""} ready`);
    if (mm) bits.push(`${mm} MM top-up${mm > 1 ? "s" : ""}`);
  }
  return bits.length ? bits.join(" · ") : "Pending review";
}

function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
