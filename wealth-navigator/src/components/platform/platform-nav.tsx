"use client";

import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth/store";
import { cn } from "@/lib/cn";
import { isBlockedForEmail } from "@/lib/platform/access";
import { type NavItem, PLATFORM_NAV, activeHref, overviewItem, visibleFor } from "@/lib/platform/nav";
import { usePersona } from "@/lib/store/session-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";

/**
 * The one platform sidebar — shared by the desk AND the admin surfaces, grouped
 * by bank function. Replaces the separate OEMS SideNav + Admin sidebar so the
 * app is one product, not two.
 *
 * Visibility (stopgap until the auth/RBAC phase wires per-user `page_access`):
 *  • A real signed-in user sees the FULL nav — the demo persona selector must
 *    not hide sections from actual staff.
 *  • Only the no-session dev/design preview falls back to persona gating, so the
 *    top-bar persona switcher can still demo each role's surface.
 * Per-role page-access gating replaces the `showAll` shortcut once RBAC lands.
 */
export function PlatformNav() {
  const pathname = usePathname() ?? "";
  const persona = usePersona();
  const { isAuthenticated } = useAuth();
  const [collapsed, setCollapsed] = React.useState(false);
  const [openSections, setOpenSections] = React.useState<Set<string> | null>(null);
  const [ccCount, setCcCount] = React.useState(0);
  // Signed-in email, for the per-user restriction (see lib/platform/access.ts).
  const [email, setEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isSupabaseAuthConfigured()) return;
    let alive = true;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data } = await supabase.auth.getSession();
        if (alive) setEmail(data.session?.user?.email ?? null);
      } catch {
        /* leave email null → no restriction applied */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const active = activeHref(pathname);

  const sections = React.useMemo(() => {
    const overview = { title: "Overview", items: [overviewItem(persona)] };
    const rest = PLATFORM_NAV.map((s) => ({
      ...s,
      // A restricted external account never sees the sensitive business items,
      // even though authenticated staff otherwise see the full nav.
      items: s.items.filter(
        (i) => (isAuthenticated || visibleFor(persona, i)) && !isBlockedForEmail(email, i.href),
      ),
    })).filter((s) => s.items.length > 0);
    return [overview, ...rest];
  }, [persona, isAuthenticated, email]);

  const showCc = sections.some((s) => s.items.some((i) => i.badge === "cc"));
  const expandedSections = React.useMemo(
    () => openSections ?? new Set(sections.map((section) => section.title)),
    [openSections, sections],
  );

  React.useEffect(() => {
    const activeSection = sections.find((section) => section.items.some((item) => item.href === active));
    if (!activeSection) return;
    setOpenSections((current) => {
      if (current == null || current.has(activeSection.title)) return current;
      const next = new Set(current);
      next.add(activeSection.title);
      return next;
    });
  }, [active, sections]);

  const toggleSection = React.useCallback(
    (title: string) => {
      setOpenSections((current) => {
        const next = new Set(current ?? sections.map((section) => section.title));
        if (next.has(title)) next.delete(title);
        else next.add(title);
        return next;
      });
    },
    [sections],
  );

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

  return (
    <aside
      className={cn(
        "isolate flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 [contain:paint]",
        collapsed ? "w-[60px]" : "w-[216px]",
      )}
    >
      <nav className="flex-1 overflow-y-auto overscroll-contain py-3 scrollbar-thin [contain:paint]">
        {sections.map((section) => {
          const sectionOpen = collapsed || expandedSections.has(section.title);
          const sectionId = `platform-nav-${section.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
          return (
            <div key={section.title} className="mb-4">
              {!collapsed && (
                <button
                  type="button"
                  aria-expanded={sectionOpen}
                  aria-controls={sectionId}
                  onClick={() => toggleSection(section.title)}
                  className="flex w-full items-center gap-1 px-3.5 pb-1 text-left text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  {sectionOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{section.title}</span>
                </button>
              )}
              <ul id={sectionId} hidden={!sectionOpen} className="space-y-0.5 px-1.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLinkItem
                      item={item}
                      active={item.href === active}
                      collapsed={collapsed}
                      badgeCount={item.badge === "cc" ? ccCount : 0}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="h-7 w-full justify-center text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </aside>
  );
}

function NavLinkItem({
  item,
  active,
  collapsed,
  badgeCount,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  badgeCount: number;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href as Route}
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
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && badgeCount > 0 && (
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-label={`${badgeCount} open`} />
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="text-[11px]">
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}
