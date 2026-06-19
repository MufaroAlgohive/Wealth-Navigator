"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Users, MonitorSmartphone, LayoutDashboard, Layers, FileText, TrendingUp,
  BookOpen, Banknote, Sunrise, Mail, Settings as SettingsIcon, SlidersHorizontal,
  ShieldCheck, Shield, LogOut, AlertTriangle, type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  ADMIN_PAGES, ADMIN_SECTION_ORDER, canAccessPage, adminPageForPath,
  type AdminSection,
} from "@/lib/admin/pages";
import { useAdmin } from "@/lib/admin/context";

const ICONS: Record<string, LucideIcon> = {
  Users, MonitorSmartphone, LayoutDashboard, Layers, FileText, TrendingUp,
  BookOpen, Banknote, Sunrise, Mail, Settings: SettingsIcon, SlidersHorizontal,
  ShieldCheck, Shield,
};

const SECTION_LABELS: Record<AdminSection, string> = {
  MAIN: "Main",
  INVESTMENTS: "Investments",
  BANKING: "Banking",
  COMMUNICATIONS: "Communications",
  SYSTEM: "System",
};

function initials(name: string | null, email: string): string {
  const src = (name && name.trim()) || email;
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { ctx, notice } = useAdmin();
  const pathname = usePathname();
  const router = useRouter();
  const [ccCount, setCcCount] = React.useState(0);

  const visiblePages = React.useMemo(() => ADMIN_PAGES.filter((p) => canAccessPage(ctx, p)), [ctx]);
  const currentTitle = adminPageForPath(pathname ?? "")?.label ?? "Admin";
  const showCc = visiblePages.some((p) => p.key === "cyber-compliance");

  // CC incident badge poller (parity with legacy cc-badge.js). No-ops until
  // /api/admin/cyber-compliance lands; silent on non-200.
  React.useEffect(() => {
    if (!showCc) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/admin/cyber-compliance?action=badge-count");
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setCcCount(Number(d?.count) || 0);
      } catch {
        /* silent */
      }
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [showCc]);

  const signOut = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    router.push("/login");
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-foreground">
      {notice && (
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-[11px] text-warning-foreground">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          <span className="text-foreground/80">{notice}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[224px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Shield className="h-4 w-4" />
            </div>
            <div className="leading-tight">
              <div className="text-[13px] font-bold text-foreground">Mint</div>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Admin Panel</div>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto py-3 scrollbar-thin">
            {ADMIN_SECTION_ORDER.map((section) => {
              const items = visiblePages.filter((p) => p.section === section);
              if (items.length === 0) return null;
              return (
                <div key={section} className="mb-4">
                  <p className="px-3.5 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {SECTION_LABELS[section]}
                  </p>
                  <ul className="space-y-0.5 px-1.5">
                    {items.map((p) => {
                      const Icon = ICONS[p.icon] ?? LayoutDashboard;
                      const active = pathname === p.path || (pathname?.startsWith(`${p.path}/`) ?? false);
                      return (
                        <li key={p.key}>
                          <Link
                            href={p.path as Route}
                            className={cn(
                              "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
                              active
                                ? "bg-sidebar-accent text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]"
                                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                            )}
                          >
                            {active && (
                              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
                            )}
                            <Icon className={cn("h-3.5 w-3.5 shrink-0", active && "text-primary")} />
                            <span className="flex-1 truncate">{p.label}</span>
                            {p.key === "cyber-compliance" && ccCount > 0 && (
                              <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-label={`${ccCount} open incidents`} />
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </nav>

          <div className="border-t border-sidebar-border p-2">
            <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-bold text-primary-foreground">
                {initials(ctx.fullName, ctx.email)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-foreground">{ctx.fullName ?? ctx.email}</div>
                <div className="truncate text-[10px] capitalize text-muted-foreground">{ctx.role}</div>
              </div>
            </div>
            <Button
              variant="ghost"
              className="mt-1 h-8 w-full justify-start gap-2.5 px-2 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={signOut}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/60 px-6 backdrop-blur">
            <h1 className="text-[15px] font-bold text-foreground">{currentTitle}</h1>
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className="relative flex-1 overflow-y-auto p-4 scrollbar-thin focus:outline-none md:p-6"
          >
            <div className="mx-auto max-w-[1800px] animate-fade-in">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
