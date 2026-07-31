import {
  Activity,
  Banknote,
  BookOpen,
  BrainCircuit,
  Cable,
  CalendarClock,
  ClipboardList,
  DatabaseZap,
  FileText,
  Gift,
  Globe2,
  Landmark,
  Layers,
  LayoutDashboard,
  Library,
  LineChart,
  type LucideIcon,
  Mail,
  MonitorSmartphone,
  Newspaper,
  Scale,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sunrise,
  TrendingUp,
  Users,
  Vote,
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

/**
 * Per-role landing for the "Overview" nav item — folds the persona home pages
 * (desk Cockpit, WM book, strategist desk, business house-view, funeral-cover
 * overview) into the one sidebar so the Overview link matches where the top-bar
 * persona switcher lands. Keep in sync with PERSONA_LABEL.home in top-bar.tsx.
 */
export const PERSONA_HOME: Record<Persona, { label: string; href: string }> = {
  oems: { label: "Cockpit", href: "/oems" },
  admin: { label: "Cockpit", href: "/oems" },
  strategist: { label: "Strategist Desk", href: "/strategist" },
  wealth_manager: { label: "My Book", href: "/wm" },
  business: { label: "House View", href: "/business" },
  funeral_cover: { label: "Cover Overview", href: "/fc/overview" },
};

/** The role-aware "Overview" item rendered at the top of the sidebar. */
export function overviewItem(persona: Persona): NavItem {
  const home = PERSONA_HOME[persona];
  return { label: home.label, href: home.href, icon: LayoutDashboard };
}

export const PLATFORM_NAV: NavSection[] = [
  {
    title: "Markets",
    items: [
      { label: "Securities", href: "/oems/equities", icon: TrendingUp, roles: [DESK, STRAT, WM] },
      { label: "Analysis", href: "/analysis", icon: Search, roles: [DESK, STRAT, WM, BIZ] },
      { label: "Fixed Income", href: "/oems/fixed-income", icon: LineChart, roles: [DESK, STRAT] },
      { label: "Money Market", href: "/oems/money-market", icon: Banknote, roles: [DESK, STRAT] },
      { label: "Curves", href: "/oems/curves", icon: Activity, roles: [DESK, STRAT] },
      { label: "Macro", href: "/oems/macro", icon: Globe2, roles: [DESK, STRAT, BIZ] },
      { label: "IRESS Migration", href: "/oems/iress-migration", icon: Cable, roles: [DESK] },
    ],
  },
  {
    // Lonwabo: Order Book should sit higher / be more reachable —
    // "Orders & Cash" moved directly under "Markets" (above "Strategies").
    title: "Orders & Cash",
    items: [
      { label: "Order Book", href: "/admin/order-book", icon: BookOpen, roles: [DESK, OPS] },
      { label: "Blotter", href: "/oems/blotter", icon: ClipboardList, roles: [DESK] },
      { label: "EFT Payments", href: "/admin/eft", icon: Banknote, roles: [OPS] },
      { label: "Reconciliation", href: "/fc/overview", icon: Landmark, roles: [OPS] },
    ],
  },
  {
    title: "Strategies",
    items: [
      { label: "Strategies", href: "/strategies", icon: Layers, roles: [DESK, STRAT, WM] },
      { label: "Models", href: "/oems/models", icon: BrainCircuit, roles: [DESK, STRAT] },
      { label: "Factsheets", href: "/admin/factsheets", icon: FileText },
      { label: "Return Insights", href: "/admin/dashboard", icon: LineChart, roles: [WM, BIZ] },
    ],
  },
  {
    title: "Clients & Investors",
    items: [
      { label: "Clients", href: "/admin/clients", icon: Users, roles: [WM, OPS] },
      { label: "Investors", href: "/admin/investors", icon: TrendingUp, roles: [WM, BIZ] },
      { label: "Gifting", href: "/admin/gifting", icon: Gift, roles: [] },
      { label: "Client View Studio", href: "/admin/studio", icon: MonitorSmartphone, roles: [WM] },
    ],
  },
  {
    // The Research → IC → Rebalance workflow (institutional desk). Mirrors the
    // "RESEARCH & IC" group in the OEMS design: one route per surface.
    title: "Research & IC",
    items: [
      { label: "Research Library", href: "/oems/research", icon: Library, roles: [DESK, STRAT] },
      { label: "Rebalance Builder", href: "/oems/rebalance", icon: Scale, roles: [DESK, STRAT] },
      { label: "Investment Cmte.", href: "/oems/committee", icon: Vote, roles: [DESK, STRAT] },
      { label: "Desk Rhythm", href: "/oems/rhythm", icon: CalendarClock, roles: [DESK, STRAT] },
    ],
  },
  {
    title: "Intelligence & Comms",
    items: [
      { label: "News & SENS", href: "/oems/news", icon: Newspaper },
      { label: "Mint Mornings", href: "/admin/mint-mornings", icon: Sunrise, roles: [BIZ] },
      { label: "Emailers & Triggers", href: "/admin/emailers", icon: Mail, roles: [BIZ] },
    ],
  },
  {
    title: "Governance & Platform",
    items: [
      { label: "Source of Truth", href: "/admin/source-of-truth", icon: DatabaseZap, roles: [] },
      { label: "Approvals & Compliance", href: "/compliance", icon: Shield, roles: [] },
      {
        label: "Cyber Compliance",
        href: "/admin/cyber-compliance",
        icon: ShieldCheck,
        roles: [],
        badge: "cc",
      },
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

/** Longest-matching href so `/oems` doesn't light up on `/oems/blotter`. Considers
 *  the per-role Overview homes too, so /wm, /strategist, etc. light the Overview item. */
export function activeHref(pathname: string): string | null {
  let best: string | null = null;
  const candidates = [
    ...Object.values(PERSONA_HOME).map((h) => h.href),
    ...PLATFORM_NAV.flatMap((s) => s.items.map((i) => i.href)),
  ];
  for (const href of candidates) {
    if (pathname === href || pathname.startsWith(`${href}/`)) {
      if (!best || href.length > best.length) best = href;
    }
  }
  return best;
}
