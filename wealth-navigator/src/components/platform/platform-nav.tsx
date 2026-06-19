"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { ChevronsLeft, ChevronsRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { usePersona } from "@/lib/store/session-provider";
import { PLATFORM_NAV, visibleFor, activeHref, overviewItem, type NavItem } from "@/lib/platform/nav";

/**
 * The one platform sidebar — shared by the desk AND the admin surfaces, grouped
 * by bank function, gated by the current role (persona). Replaces the separate
 * OEMS SideNav + Admin sidebar so the app is one product, not two.
 */
export function PlatformNav() {
  const pathname = usePathname() ?? "";
  const persona = usePersona();
  const [collapsed, setCollapsed] = React.useState(false);
  const [ccCount, setCcCount] = React.useState(0);

  const active = activeHref(pathname);

  const sections = React.useMemo(() => {
    const overview = { title: "Overview", items: [overviewItem(persona)] };
    const rest = PLATFORM_NAV.map((s) => ({
      ...s,
      items: s.items.filter((i) => visibleFor(persona, i)),
    })).filter((s) => s.items.length > 0);
    return [overview, ...rest];
  }, [persona]);

  const showCc = sections.some((s) => s.items.some((i) => i.badge === "cc"));
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
        "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200",
        collapsed ? "w-[60px]" : "w-[216px]",
      )}
    >
      <nav className="flex-1 overflow-y-auto py-3 scrollbar-thin">
        {sections.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed && (
              <p className="px-3.5 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5 px-1.5">
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
        ))}
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
      {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />}
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
