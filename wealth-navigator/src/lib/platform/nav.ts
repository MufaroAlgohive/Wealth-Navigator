import {
  LayoutDashboard, TrendingUp, LineChart, Banknote, Globe2, Layers, FileText,
  ClipboardList, Users, MonitorSmartphone, BookOpen, Mail, Sunrise, Newspaper,
  FlaskConical, ShieldCheck, Shield, Cable, SlidersHorizontal, Settings, Landmark,
  Activity, type LucideIcon,
} from "lucide-react";

import type { Persona } from "@/lib/store/session-provider";

/**
 * Single source of truth for the merged platform navigation. Grouped by bank
 * FUNCTION (not by "desk" vs "admin"), with role gating per item. See
 * docs/MINT_UNIFIED_IA.md. `admin` role sees everything.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Roles that see this item. Omit = visible to everyone. */
  roles?: Persona[];
  /** Live badge source (resolved in PlatformNav). */
  badge?: "cc";
}
export interface NavSection {
  title: string;
  items: NavItem[];
}

const DESK: Persona = "oems";
const STRAT: Persona = "strategist";
const WM: Persona = "wealth_manager";
const BIZ: Persona = "business";
const OPS: Persona = "funeral_cover";

export const PLATFORM_NAV: NavSection[] = [
  {
    title: "Overview",
    items: [{ label: "Cockpit", href: "/oems", icon: LayoutDashboard }],
  },
  {
    title: "Markets",
    items: [
      { label: "Securities", href: "/oems/equities", icon: TrendingUp, roles: [DESK, STRAT, WM] },
      { label: "Fixed Income", href: "/oems/fixed-income", icon: LineChart, roles: [DESK, STRAT] },
      { label: "Money Market", href: "/oems/money-market", icon: Banknote, roles: [DESK, STRAT] },
      { label: "Curves", href: "/oems/curves", icon: Activity, roles: [DESK, STRAT] },
      { label: "Macro", href: "/oems/macro", icon: Globe2, roles: [DESK, STRAT, BIZ] },
    ],
  },
  {
    title: "Strategies",
    items: [
      { label: "Strategies", href: "/strategies", icon: Layers, roles: [DESK, STRAT, WM] },
      { label: "Factsheets", href: "/admin/factsheets", icon: FileText },
      { label: "Return Insights", href: "/admin/dashboard", icon: LineChart, roles: [WM, BIZ] },
    ],
  },
  {
    title: "Clients & Investors",
    items: [
      { label: "Clients", href: "/admin/clients", icon: Users, roles: [WM, OPS] },
      { label: "Investors", href: "/admin/investors", icon: TrendingUp, roles: [WM, BIZ] },
      { label: "Client View Studio", href: "/admin/studio", icon: MonitorSmartphone, roles: [WM] },
    ],
  },
  {
    title: "Orders & Cash",
    items: [
      { label: "Order Book", href: "/admin/order-book", icon: BookOpen, roles: [DESK, OPS] },
      { label: "Blotter", href: "/oems/blotter", icon: ClipboardList, roles: [DESK] },
      { label: "EFT Payments", href: "/admin/eft", icon: Banknote, roles: [OPS] },
      { label: "Reconciliation", href: "/fc/overview", icon: Landmark, roles: [OPS] },
    ],
  },
  {
    title: "Intelligence & Comms",
    items: [
      { label: "News & SENS", href: "/oems/news", icon: Newspaper },
      { label: "Research Lab", href: "/oems/research-lab", icon: FlaskConical, roles: [DESK, STRAT] },
      { label: "Mint Mornings", href: "/admin/mint-mornings", icon: Sunrise, roles: [BIZ] },
      { label: "Emailers & Triggers", href: "/admin/emailers", icon: Mail, roles: [BIZ] },
    ],
  },
  {
    title: "Governance & Platform",
    items: [
      { label: "Approvals & Compliance", href: "/compliance", icon: Shield, roles: [] },
      { label: "Cyber Compliance", href: "/admin/cyber-compliance", icon: ShieldCheck, roles: [], badge: "cc" },
      { label: "Integration", href: "/oems/integration", icon: Cable, roles: [DESK] },
      { label: "Team & Access", href: "/admin/team", icon: Users, roles: [] },
      { label: "App Settings", href: "/admin/app-settings", icon: SlidersHorizontal, roles: [] },
      { label: "Settings", href: "/admin/settings", icon: Settings },
    ],
  },
];

/** Whether a role sees an item. `admin` sees all; empty roles = admin-only. */
export function visibleFor(persona: Persona, item: NavItem): boolean {
  if (persona === "admin") return true;
  if (!item.roles) return true;
  return item.roles.includes(persona);
}

/** Longest-matching href so `/oems` doesn't light up on `/oems/blotter`. */
export function activeHref(pathname: string): string | null {
  let best: string | null = null;
  for (const section of PLATFORM_NAV) {
    for (const item of section.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        if (!best || item.href.length > best.length) best = item.href;
      }
    }
  }
  return best;
}
