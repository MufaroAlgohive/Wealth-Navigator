/**
 * Admin (Mint CRM) page registry — the single source of truth for the merged
 * admin surface's routes, nav grouping, and page-access keys.
 *
 * Server-safe (no React / no icons) so it can be imported by RBAC, middleware,
 * and route handlers as well as the client shell. Icons are mapped in the shell.
 *
 * Mirrors the legacy MyMintAdmin sidebar + `access-guard.js` NAV_PAGE_MAP.
 */

export type AdminSection = "MAIN" | "INVESTMENTS" | "BANKING" | "COMMUNICATIONS" | "SYSTEM";

/** page_access key as stored in `admin_team.page_access` (legacy parity). */
export type AdminPageKey =
  | "clients"
  | "studio"
  | "dashboard"
  | "strategies"
  | "factsheets"
  | "investors"
  | "orderbook"
  | "eft"
  | "mint-mornings"
  | "emailers"
  | "settings"
  | "app-settings"
  | "team"
  | "cyber-compliance";

export interface AdminPage {
  key: AdminPageKey;
  path: `/admin/${string}`;
  label: string;
  section: AdminSection;
  /** Admin/superadmin (or dev tier) only — not grantable via page_access. */
  adminOnly: boolean;
  /** Lucide icon name (resolved to a component in the client shell). */
  icon: string;
}

export const ADMIN_PAGES: readonly AdminPage[] = [
  { key: "clients",          path: "/admin/clients",          label: "Clients",            section: "MAIN",           adminOnly: false, icon: "Users" },
  { key: "studio",           path: "/admin/studio",           label: "Client View Studio", section: "MAIN",           adminOnly: true,  icon: "MonitorSmartphone" },
  { key: "dashboard",        path: "/admin/dashboard",        label: "Dashboard",          section: "INVESTMENTS",    adminOnly: false, icon: "LayoutDashboard" },
  { key: "strategies",       path: "/admin/strategies",       label: "Strategies",         section: "INVESTMENTS",    adminOnly: false, icon: "Layers" },
  { key: "factsheets",       path: "/admin/factsheets",       label: "Factsheets",         section: "INVESTMENTS",    adminOnly: false, icon: "FileText" },
  { key: "investors",        path: "/admin/investors",        label: "Investors",          section: "INVESTMENTS",    adminOnly: false, icon: "TrendingUp" },
  { key: "orderbook",        path: "/admin/order-book",       label: "Order Book",         section: "INVESTMENTS",    adminOnly: false, icon: "BookOpen" },
  { key: "eft",              path: "/admin/eft",              label: "EFT Payments",       section: "BANKING",        adminOnly: false, icon: "Banknote" },
  { key: "mint-mornings",    path: "/admin/mint-mornings",    label: "Mint Mornings",      section: "COMMUNICATIONS", adminOnly: true,  icon: "Sunrise" },
  { key: "emailers",         path: "/admin/emailers",         label: "Emailers & Triggers", section: "COMMUNICATIONS", adminOnly: true,  icon: "Mail" },
  { key: "settings",         path: "/admin/settings",         label: "Settings",           section: "SYSTEM",         adminOnly: false, icon: "Settings" },
  { key: "app-settings",     path: "/admin/app-settings",     label: "App Settings",       section: "SYSTEM",         adminOnly: true,  icon: "SlidersHorizontal" },
  { key: "team",             path: "/admin/team",             label: "Team",               section: "SYSTEM",         adminOnly: true,  icon: "ShieldCheck" },
  { key: "cyber-compliance", path: "/admin/cyber-compliance", label: "Cyber Compliance",   section: "SYSTEM",         adminOnly: false, icon: "Shield" },
] as const;

export const ADMIN_SECTION_ORDER: readonly AdminSection[] = [
  "MAIN",
  "INVESTMENTS",
  "BANKING",
  "COMMUNICATIONS",
  "SYSTEM",
];

export function adminPageForPath(pathname: string): AdminPage | undefined {
  // Longest-prefix match so nested routes resolve to their section page.
  return [...ADMIN_PAGES]
    .sort((a, b) => b.path.length - a.path.length)
    .find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));
}

/** Minimal access shape — shared by server RBAC and the client shell. */
export interface AdminAccess {
  role: string;
  pageAccess: string[];
  approverTier: "dev" | "master" | null;
}

export function isAdminRole(a: Pick<AdminAccess, "role">): boolean {
  return a.role === "admin" || a.role === "superadmin";
}

/** Whether the access context may view a given admin page (pure). */
export function canAccessPage(a: AdminAccess, page: Pick<AdminPage, "key" | "adminOnly">): boolean {
  if (a.approverTier === "dev") return true;
  if (isAdminRole(a)) return true;
  if (page.adminOnly) return false;
  return a.pageAccess.includes(page.key);
}

/** First page the access context is allowed to see — post-login landing. */
export function firstAllowedPath(a: AdminAccess): AdminPage["path"] {
  const allowed = ADMIN_PAGES.find((p) => canAccessPage(a, p));
  return allowed?.path ?? "/admin/settings";
}
