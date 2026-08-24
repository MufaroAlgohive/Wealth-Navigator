"use client";

import { Check, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Filter } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth/store";
import { cn } from "@/lib/cn";
import { isBlockedForEmail } from "@/lib/platform/access";
import { type NavItem, PLATFORM_NAV, activeHref, activeSectionTitle, overviewItem, visibleFor } from "@/lib/platform/nav";
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
const FILTER_ALL = "All";
/** Deliberate business default (not Overview, not All) — see the Filter dropdown. */
const DEFAULT_FILTER = "Markets";
const FILTER_STORAGE_KEY = "mint-platform-nav-filter";
/** Idle time within the sidebar before it auto-collapses to icon-only. */
const IDLE_COLLAPSE_MS = 10_000;

export function PlatformNav() {
  const pathname = usePathname() ?? "";
  const persona = usePersona();
  const routeSection = activeSectionTitle(pathname);
  const { isAuthenticated } = useAuth();
  const [collapsed, setCollapsed] = React.useState(false);
  const [openSections, setOpenSections] = React.useState<Set<string> | null>(null);
  const [ccCount, setCcCount] = React.useState(0);
  // Signed-in email, for the per-user restriction (see lib/platform/access.ts).
  const [email, setEmail] = React.useState<string | null>(null);
  // Section filter: "All" restores the current collapsible-groups behavior;
  // any other value shows only that section's items, flat, un-collapsible.
  // Defaults to "Markets" per an explicit business decision — see DEFAULT_FILTER.
  const [filter, setFilter] = React.useState<string>(() => routeSection ?? DEFAULT_FILTER);
  const filterTouchedRef = React.useRef(false);

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

  const filterOptions = React.useMemo(() => sections.map((s) => s.title), [sections]);

  // On first load (and across route changes while the user has not deliberately
  // chosen a filter), follow the route's owning section. This matters when a
  // navigation crosses layout boundaries and remounts the sidebar: /oems/models
  // must restore Strategies, not the generic Markets default.
  React.useEffect(() => {
    if (filterTouchedRef.current) return;
    const stored = (() => {
      try {
        return window.sessionStorage.getItem(FILTER_STORAGE_KEY);
      } catch {
        return null;
      }
    })();
    const storedOwnsRoute = stored
      ? sections.some(
          (section) =>
            section.title === stored && section.items.some((item) => item.href === active),
        )
      : false;
    if (stored && filterOptions.includes(stored) && (storedOwnsRoute || !routeSection)) {
      setFilter(stored);
    } else if (routeSection && filterOptions.includes(routeSection)) {
      setFilter(routeSection);
    } else if (filterOptions.includes(DEFAULT_FILTER)) {
      setFilter(DEFAULT_FILTER);
    } else if (filterOptions.length > 0 && !filterOptions.includes(filter)) {
      setFilter(FILTER_ALL);
    }
  }, [active, filterOptions, filter, routeSection, sections]);

  const selectFilter = React.useCallback((next: string) => {
    filterTouchedRef.current = true;
    setFilter(next);
    try {
      window.sessionStorage.setItem(FILTER_STORAGE_KEY, next);
    } catch {
      /* Navigation still works when storage is unavailable. */
    }
  }, []);

  const visibleSections = React.useMemo(
    () => (filter === FILTER_ALL ? sections : sections.filter((s) => s.title === filter)),
    [sections, filter],
  );

  // Sidebar-scoped idle auto-collapse: any interaction WITHIN the <aside> (not
  // page-wide) resets a 10s timer; on expiry, collapse to icon-only. Reuses the
  // existing `collapsed` state rather than a second collapse mechanism.
  const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetIdleTimer = React.useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setCollapsed(true), IDLE_COLLAPSE_MS);
  }, []);
  React.useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

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

  const isFiltered = filter !== FILTER_ALL;

  return (
    <aside
      onMouseMove={resetIdleTimer}
      onPointerMove={resetIdleTimer}
      onClick={resetIdleTimer}
      onKeyDown={resetIdleTimer}
      onFocus={resetIdleTimer}
      className={cn(
        "isolate flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 [contain:paint]",
        collapsed ? "w-[60px]" : "w-[216px]",
      )}
    >
      <div className={cn("border-b border-sidebar-border", collapsed ? "px-1.5 py-2" : "px-2 py-2")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {collapsed ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Filter navigation: ${filter}`}
                className="h-7 w-full justify-center text-muted-foreground hover:text-foreground"
              >
                <Filter className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <button
                type="button"
                aria-label={`Filter navigation, currently ${filter}`}
                className="flex w-full items-center justify-between gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Filter className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{filter}</span>
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Filter sections</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => selectFilter(FILTER_ALL)}
              className={cn("justify-between", filter === FILTER_ALL && "bg-accent")}
            >
              <span>All</span>
              {filter === FILTER_ALL && <Check className="h-3 w-3" aria-hidden="true" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {filterOptions.map((title) => (
              <DropdownMenuItem
                key={title}
                onSelect={() => selectFilter(title)}
                className={cn("justify-between", filter === title && "bg-accent")}
              >
                <span className="truncate">{title}</span>
                {filter === title && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav className="flex-1 overflow-y-auto overscroll-contain py-3 scrollbar-thin [contain:paint]">
        {isFiltered
          ? // Filtered to one section: flat item list, no header, nothing to collapse.
            visibleSections.map((section) => (
              <ul key={section.title} className="space-y-0.5 px-1.5">
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
            ))
          : sections.map((section) => {
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
