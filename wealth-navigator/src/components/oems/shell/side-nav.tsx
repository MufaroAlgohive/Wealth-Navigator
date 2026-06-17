"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, ClipboardList, Layers, LineChart, Banknote, TrendingUp,
  Globe2, Newspaper, Search, Cable, ChevronsLeft, ChevronsRight, Activity, FlaskConical,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/oems/primitives/pill";
import { useSideNavBadges } from "@/lib/hooks/use-side-nav-badges";
import type { Route } from "next";

interface NavItem {
  to: string;
  label: string;
  icon: React.ElementType;
  badge?: string | number;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    title: "Live",
    items: [
      { to: "/oems",                label: "Cockpit",      icon: LayoutDashboard },
      { to: "/oems/blotter",        label: "Blotter",      icon: ClipboardList, badge: "12" },
      { to: "/oems/security",       label: "Security",     icon: Search },
    ],
  },
  {
    title: "Book",
    items: [
      { to: "/oems/strategies",     label: "Strategies",   icon: Layers, badge: "6" },
    ],
  },
  {
    title: "Markets",
    items: [
      { to: "/oems/equities",       label: "Equities",     icon: TrendingUp },
      { to: "/oems/fixed-income",   label: "Fixed Income", icon: LineChart },
      { to: "/oems/money-market",   label: "Money Market", icon: Banknote },
      { to: "/oems/curves",         label: "Curves",       icon: LineChart },
    ],
  },
  {
    title: "Info",
    items: [
      { to: "/oems/macro",          label: "Macro",        icon: Globe2 },
      { to: "/oems/news",           label: "News & SENS",  icon: Newspaper, badge: "4" },
      { to: "/oems/research-lab",   label: "Research Lab", icon: FlaskConical },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/oems/integration",    label: "Integration",  icon: Cable },
    ],
  },
];

export function SideNav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const { resolve: resolveBadge } = useSideNavBadges();

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200",
        collapsed ? "w-[60px]" : "w-[208px]",
      )}
    >
      <div className="flex h-12 items-center gap-2 border-b border-sidebar-border px-3">
        <Pill tone="primary" size="sm" dot>
          {collapsed ? "OMS" : "OEMS · v2.0"}
        </Pill>
      </div>
      <nav className="flex-1 overflow-y-auto py-3 scrollbar-thin">
        {NAV.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed && (
              <p className="px-3.5 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5 px-1.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLinkItem
                    item={{ ...item, badge: resolveBadge(item.to, item.badge) }}
                    active={pathname === item.to}
                    collapsed={collapsed}
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
          aria-label={collapsed ? "Expand nav" : "Collapse nav"}
          className="h-7 w-full justify-center text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </aside>
  );
}

function NavLinkItem({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.to as Route<string>}
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
      {!collapsed && item.badge && (
        <span className="rounded bg-muted/70 px-1.5 font-mono text-[9.5px] text-muted-foreground">{item.badge}</span>
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="font-mono text-[10px]">
        {item.label}{item.badge ? ` · ${item.badge}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}
