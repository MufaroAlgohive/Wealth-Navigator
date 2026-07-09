/**
 * Mint OEM RBAC key registry — union types for the granular permissions[section][field]
 * matrix and the page-access keys used by the Team page picker and the gating
 * helpers (`useCan`, `can`).
 *
 * Sections vs. keys:
 *   • `RbacPageKey` — what a staff member is granted access to via
 *     admin_team.page_access (mirrors legacy `AdminPageKey`).
 *   • `RbacButtonKey` — the per-action toggle (mostly boolean) inside a page
 *     defined by PERMISSION_MATRIX. Format is `<section>/<field>`.
 *
 * Centralised so adding a new page or button is one place to touch, and `useCan`
 * can assert at the call site.
 */

/** Page-access keys (mirrors `AdminPageKey` in `lib/admin/pages.ts`, expanded). */
export type RbacPageKey =
  // Main
  | "clients"
  | "studio"
  // Investments
  | "dashboard"
  | "strategies"
  | "factsheets"
  | "investors"
  | "orderbook"
  // Banking (A4)
  | "banking/eft"
  | "banking/reconciliation"
  | "banking/wallet-topup"
  // Marketing (A4)
  | "marketing/mint-mornings"
  | "marketing/emailers"
  // Research lab + IC + rebalance (A4 — wired for Phase B)
  | "research-lab/analyst"
  | "research-lab/ic"
  | "research-lab/voting"
  | "rebalance/builder"
  | "approvals/action-items"
  // System
  | "settings"
  | "app-settings"
  | "team"
  | "cyber-compliance";

/**
 * Granular button/action toggle keys. Format `<section>/<field>` where
 * `<section>` matches a section.key in `PERMISSION_MATRIX`.
 */
export type RbacButtonKey =
  // Order Book (existing + new)
  | "orderbook/send_confirmation"
  | "orderbook/edit_fill_price"
  | "orderbook/push_rebalance"
  | "orderbook/send_to_market"
  | "orderbook/refund_investor"
  | "orderbook/export"
  // Dashboard
  | "dashboard/view_financials"
  | "dashboard/commit_rebalance"
  | "dashboard/sync_fundamentals"
  // EFT & Wallet (existing + split approve/reject)
  | "eft/approve_eft"
  | "eft/reject_eft"
  | "eft/approve_deposits"
  | "eft/manual_funds"
  // Clients
  | "clients/manage_kyc"
  | "clients/edit_profiles"
  // Strategies
  | "strategies/manage_strategies"
  | "strategies/change_visibility"
  // Factsheets
  | "factsheets/upload_factsheets"
  // Research Lab (A4)
  | "research-lab/create_research_note"
  | "research-lab/submit_to_ic"
  | "research-lab/cast_vote"
  // Rebalance builder (A4)
  | "rebalance/push_rebalance"
  // Approvals banner (A4)
  | "approvals/resolve_action_items";

/**
 * Compile-time sanity check so a typo at a `useCan` call site fails the build
 * instead of silently dropping the grant. The intersection lists the keys
 * currently advertised by the page sections.
 */
export const RBAC_BUTTON_KEYS: ReadonlySet<RbacButtonKey> = new Set<RbacButtonKey>([
  "orderbook/send_confirmation",
  "orderbook/edit_fill_price",
  "orderbook/push_rebalance",
  "orderbook/send_to_market",
  "orderbook/refund_investor",
  "orderbook/export",
  "dashboard/view_financials",
  "dashboard/commit_rebalance",
  "dashboard/sync_fundamentals",
  "eft/approve_eft",
  "eft/reject_eft",
  "eft/approve_deposits",
  "eft/manual_funds",
  "clients/manage_kyc",
  "clients/edit_profiles",
  "strategies/manage_strategies",
  "strategies/change_visibility",
  "factsheets/upload_factsheets",
  "research-lab/create_research_note",
  "research-lab/submit_to_ic",
  "research-lab/cast_vote",
  "rebalance/push_rebalance",
  "approvals/resolve_action_items",
]);

export const RBAC_PAGE_KEYS: ReadonlySet<RbacPageKey> = new Set<RbacPageKey>([
  "clients",
  "studio",
  "dashboard",
  "strategies",
  "factsheets",
  "investors",
  "orderbook",
  "banking/eft",
  "banking/reconciliation",
  "banking/wallet-topup",
  "marketing/mint-mornings",
  "marketing/emailers",
  "research-lab/analyst",
  "research-lab/ic",
  "research-lab/voting",
  "rebalance/builder",
  "approvals/action-items",
  "settings",
  "app-settings",
  "team",
  "cyber-compliance",
]);

/** Type-guard for an unknown page key. */
export function isRbacPageKey(k: string): k is RbacPageKey {
  return (RBAC_PAGE_KEYS as ReadonlySet<string>).has(k);
}

/** Type-guard for an unknown button key. */
export function isRbacButtonKey(k: string): k is RbacButtonKey {
  return (RBAC_BUTTON_KEYS as ReadonlySet<string>).has(k);
}
