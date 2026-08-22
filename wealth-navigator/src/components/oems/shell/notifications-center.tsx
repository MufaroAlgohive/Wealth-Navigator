"use client";

/**
 * NotificationsCenter — right-side sliding panel for the top-bar bell.
 *
 * Categories (in order):
 *   1. ACTION     — pending admin action items (EFT, approvals, etc.)
 *                    surfaced only when the calling user is an admin.
 *   2. SYSTEM     — IRESS service-call errors / warns from the Railway
 *                    worker's recent_events buffer, plus heartbeat staleness.
 *   3. DATA       — IRESS-overlay and Yahoo-fallback activations on the most
 *                    recent `/api/equities` read.
 *
 * Each item can be marked read (persisted in localStorage). Unread count
 * drives the red dot on the bell. Clicking a category filter scopes the
 * list; clicking "Mark all read" clears the unread state.
 *
 * Backend: `/api/notifications`. Polled every 30s; the bell's red-dot count
 * is the only thing that re-renders more often (a lightweight refetch on
 * page focus via the visibilitychange API).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Database,
  Loader2,
  Radio,
  Settings2,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";

export type NotificationCategory = "action" | "system" | "data";
export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  message: string;
  ts: string;
  href?: string;
  unread?: boolean;
}

interface NotificationsPayload {
  ok: boolean;
  count: number;
  unreadCount: number;
  systemCount: number;
  dataCount: number;
  actionCount: number;
  items: NotificationItem[];
}

const POLL_MS = 30_000;
const READ_STORAGE_KEY = "mint.notifications.read.v1";

const SEVERITY_STYLES: Record<NotificationSeverity, { dot: string; bar: string; chip: string }> = {
  info: { dot: "bg-info", bar: "bg-info/30", chip: "bg-info/10 text-info" },
  warning: { dot: "bg-warning", bar: "bg-warning/30", chip: "bg-warning/10 text-warning" },
  critical: { dot: "bg-destructive", bar: "bg-destructive/30", chip: "bg-destructive/10 text-destructive" },
};

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  action: "Action required",
  system: "System",
  data: "Data feed",
};

const CATEGORY_ICON: Record<NotificationCategory, React.ElementType> = {
  action: Zap,
  system: Radio,
  data: Database,
};

function fmtRel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function loadReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x) => typeof x === "string"));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveReadIds(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota / private mode */
  }
}

export function useUnreadNotifications() {
  const q = useQuery<NotificationsPayload>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const r = await fetch("/api/notifications", { cache: "no-store" });
      if (!r.ok) throw new Error(`notifications ${r.status}`);
      return r.json();
    },
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: POLL_MS / 2,
  });
  const [readIds, setReadIds] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => {
    setReadIds(loadReadIds());
  }, []);
  // Server tells us each item's `unread` flag (best-effort: always true for
  // fresh items). The local "read" set wins: items in the set are NOT unread.
  const items = (q.data?.items ?? []).map((it) => (readIds.has(it.id) ? { ...it, unread: false } : it));
  const unreadCount = items.filter((it) => it.unread).length;
  const markRead = React.useCallback((id: string) => {
    setReadIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadIds(next);
      return next;
    });
  }, []);
  const markAllRead = React.useCallback(() => {
    const all = new Set(items.map((it) => it.id));
    setReadIds(all);
    saveReadIds(all);
  }, [items]);
  return {
    items,
    unreadCount,
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
    markRead,
    markAllRead,
    counts: {
      system: items.filter((i) => i.category === "system").length,
      data: items.filter((i) => i.category === "data").length,
      action: items.filter((i) => i.category === "action").length,
    },
  };
}

export function NotificationsTrigger({
  unreadCount,
  onClick,
}: {
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Notifications${unreadCount > 0 ? ` · ${unreadCount} unread` : ""}`}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Activity className="h-4 w-4" />
      {unreadCount > 0 ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold tabular-nums text-destructive-foreground ring-2 ring-card"
          style={{ animation: unreadCount > 0 ? "notif-dot-pulse 1.8s ease-in-out infinite" : undefined }}
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}

interface NotificationsCenterProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  initialCategory?: NotificationCategory;
}

export function NotificationsCenter({ open, onOpenChange, initialCategory }: NotificationsCenterProps) {
  const qc = useQueryClient();
  const { items, unreadCount, isLoading, error, refetch, markRead, markAllRead, counts } =
    useUnreadNotifications();
  const [activeCategory, setActiveCategory] = React.useState<NotificationCategory | "all">(
    initialCategory ?? "all",
  );
  // Refocus active category to "action" first when there are pending actions.
  React.useEffect(() => {
    if (counts.action > 0 && activeCategory === "all") {
      setActiveCategory("action");
    }
  }, [counts.action, activeCategory]);
  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Inject pulse keyframes once.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("notif-center-keyframes")) return;
    const style = document.createElement("style");
    style.id = "notif-center-keyframes";
    style.textContent = `
@keyframes notif-dot-pulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 hsl(var(--destructive) / 0.55); }
  50% { transform: scale(1.08); box-shadow: 0 0 0 6px hsl(var(--destructive) / 0); }
}
@keyframes notif-slide-in {
  0% { transform: translateX(20px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}
`.trim();
    document.head.appendChild(style);
  }, []);

  const filtered = activeCategory === "all" ? items : items.filter((i) => i.category === activeCategory);

  return (
    <>
      {/* Backdrop */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: dismissable via Escape + close button + outside click on Panel */}
      <button
        type="button"
        aria-label="Close notifications"
        tabIndex={-1}
        onClick={() => onOpenChange(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {/* Panel */}
      {/* biome-ignore lint/a11y/useSemanticElements: slide-out side-panel, not a centered modal — <aside> is correct */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full max-w-[420px] flex-col border-l border-border bg-card shadow-2xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
        style={{ animation: open ? "notif-slide-in 280ms cubic-bezier(0.32, 0.72, 0, 1)" : undefined }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Notifications</h2>
            <p className="text-[11px] text-muted-foreground">
              {unreadCount > 0 ? `${unreadCount} unread of ${items.length}` : `${items.length} total`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refetch()}
              aria-label="Refresh"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Activity className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close notifications"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Category filter chips */}
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-5 py-3 scrollbar-thin">
          <FilterChip
            active={activeCategory === "all"}
            onClick={() => setActiveCategory("all")}
            label="All"
            count={items.length}
            accent="default"
          />
          <FilterChip
            active={activeCategory === "action"}
            onClick={() => setActiveCategory("action")}
            label="Action"
            count={counts.action}
            accent="warning"
            icon={<Zap className="h-3 w-3" />}
          />
          <FilterChip
            active={activeCategory === "system"}
            onClick={() => setActiveCategory("system")}
            label="System"
            count={counts.system}
            accent="info"
            icon={<Radio className="h-3 w-3" />}
          />
          <FilterChip
            active={activeCategory === "data"}
            onClick={() => setActiveCategory("data")}
            label="Data"
            count={counts.data}
            accent="info"
            icon={<Database className="h-3 w-3" />}
          />
          <span className="ml-auto inline-flex items-center">
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Check className="h-3 w-3" />
              Mark all read
            </button>
          </span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {isLoading && items.length === 0 ? (
            <div className="flex items-center justify-center px-5 py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <EmptyState
              icon={<AlertTriangle className="h-5 w-5" />}
              title="Couldn't load notifications"
              body="The notifications service is unreachable. Try refreshing."
              action={
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs hover:bg-accent"
                >
                  <Activity className="h-3.5 w-3.5" />
                  Retry
                </button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="h-5 w-5" />}
              title={activeCategory === "all" ? "All caught up" : `No ${activeCategory} notifications`}
              body={
                activeCategory === "all"
                  ? "Nothing to act on right now. The bell stays quiet when everything is healthy."
                  : `There are no ${CATEGORY_LABEL[activeCategory].toLowerCase()} notifications in this window.`
              }
            />
          ) : (
            <ul className="divide-y divide-border/50">
              {filtered.map((item) => {
                const sev = SEVERITY_STYLES[item.severity];
                const Icon = CATEGORY_ICON[item.category];
                const handleClick = () => {
                  if (item.unread) markRead(item.id);
                  if (item.href && typeof window !== "undefined") {
                    window.location.href = item.href;
                  }
                };
                const ItemBody = (
                  <>
                    <div className="relative mt-1">
                      <span
                        aria-hidden
                        className={cn(
                          "absolute -left-1 -top-1 h-2 w-2 rounded-full",
                          item.unread ? sev.dot : "bg-muted-foreground/30",
                        )}
                      />
                      <span
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-full border",
                          item.severity === "critical" &&
                            "border-destructive/40 bg-destructive/10 text-destructive",
                          item.severity === "warning" && "border-warning/40 bg-warning/10 text-warning",
                          item.severity === "info" && "border-info/40 bg-info/10 text-info",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className={cn(
                            "truncate text-[12.5px]",
                            item.unread ? "font-semibold" : "font-medium",
                          )}
                        >
                          {item.title}
                        </p>
                        <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
                          {fmtRel(item.ts)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                        {item.message}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider",
                            sev.chip,
                          )}
                        >
                          {item.severity}
                        </span>
                        <span className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                          {CATEGORY_LABEL[item.category]}
                        </span>
                        {item.href ? (
                          <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />
                        ) : null}
                      </div>
                    </div>
                  </>
                );
                return (
                  <li key={item.id} className="relative">
                    <span aria-hidden className={cn("absolute left-0 top-0 h-full w-0.5", sev.bar)} />
                    {item.href ? (
                      <a
                        href={item.href}
                        onClick={handleClick}
                        className={cn(
                          "group flex items-start gap-3 px-5 py-3 transition-colors no-underline",
                          "hover:bg-accent/40",
                          item.unread ? "bg-primary/[0.025]" : "bg-transparent",
                        )}
                      >
                        {ItemBody}
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={handleClick}
                        className={cn(
                          "group flex w-full items-start gap-3 px-5 py-3 text-left transition-colors",
                          "hover:bg-accent/40",
                          item.unread ? "bg-primary/[0.025]" : "bg-transparent",
                        )}
                      >
                        {ItemBody}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3">
          <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
            <span>{unreadCount > 0 ? `${unreadCount} unread` : "Inbox zero"}</span>
            <span>
              <Settings2 className="mr-1 inline h-3 w-3" />
              Manage preferences in /oems/account → Notifications
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  accent,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  accent?: "default" | "info" | "warning";
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
        accent === "warning" && count > 0 && !active && "border-amber-400/40 text-amber-300",
      )}
    >
      {icon}
      {label}
      {count > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 font-mono text-[9.5px] tabular-nums",
            active
              ? "bg-primary/25 text-primary"
              : accent === "warning" && count > 0
                ? "bg-amber-400/15 text-amber-300"
                : "bg-muted/50 text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/40 text-muted-foreground">
        {icon}
      </span>
      <div>
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}
