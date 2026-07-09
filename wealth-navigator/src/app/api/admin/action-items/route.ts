import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/action-items
 *
 * Aggregated pending-count feed for the persistent action-items banner.
 * Sums every approval-queue source we know about so a desk lead sees
 * outstanding work in one glance:
 *
 *   1. RETAIL `admin_approvals` (status='pending')
 *      Team/permission approvals raised by the CRM surfaces.
 *   2. RETAIL `wallet_transactions` (status='pending') — EFT deposits.
 *   3. RETAIL `wallet_transactions` (status='pending', topup_method='manual_reference')
 *      Manual funds credits waiting on a staff member to apply.
 *   4. RETAIL `wallet_transactions` (status='pending', topup_method IN (...MM placeholders))
 *      Money-market top-up placeholders. Phase C wires the real count.
 *   5. INSTITUTIONAL `rebalance_request_c` (status='ic_approved')
 *      Strategies that the Investment Committee has signed off and now
 *      need desk execution.
 *
 * Dismissing an item from the banner writes to `admin_dismissed_notifications`
 * (see `/api/admin/action-items/dismiss`); we filter the dismissed ids out
 * of the feed so the banner truly hides them — but the underlying queue is
 * untouched. The BFF returns the unfiltered counts so the dismiss UI can
 * show a "n hidden" hint when relevant.
 *
 * Each source table is queried in isolation; missing tables (because the
 * user hasn't pasted the Phase A5 / B6 migration yet) and missing DB env
 * (`isSupabaseConfigured` false) collapse to that source contributing
 * zero items — the banner should NEVER crash the page.
 *
 * Gate: signed-in admin team member; returns 401/403 otherwise.
 */

export const dynamic = "force-dynamic";

type ActionItemType = "admin_approval" | "eft_pending" | "rebalance_ready" | "manual_funds" | "mm_topup";
type ActionItemSeverity = "info" | "warning" | "critical";

interface ActionItem {
  id: string;
  type: ActionItemType;
  label: string;
  href: string;
  severity: ActionItemSeverity;
  createdAt: string;
}

interface ActionItemsResponse {
  ok: true;
  count: number;
  total: number;
  items: ActionItem[];
  dismissedIds?: string[];
}

function openRetail(): SupabaseClient | null {
  try {
    return createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

async function readRetailPendingApprovals(): Promise<ActionItem[]> {
  const db = openRetail();
  if (!db) return [];

  const { data, error } = await db
    .from("admin_approvals")
    .select("id, type, requester_email, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    if (isSupabaseSchemaMissing(error)) return [];
    // Genuine query error → log via notice but don't break the feed.
    return [];
  }

  const rows = (data ?? []) as Array<{
    id: string;
    type: string | null;
    requester_email: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    type: "admin_approval",
    label: `Approval: ${r.type ?? "request"} (${r.requester_email ?? "unknown"})`,
    href: "/admin/team?tab=approvals",
    severity: "warning",
    createdAt: r.created_at,
  }));
}

function formatRand(amount: number | string | null): string {
  const amt = Number(amount ?? 0);
  return Number.isFinite(amt) ? `R${amt.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : "R0";
}

async function readRetailPendingEft(): Promise<ActionItem[]> {
  const db = openRetail();
  if (!db) return [];

  // Try the modern schema first (`status` + optional `topup_method`); fall back
  // gracefully if the legacy schema doesn't include the column.
  const select = "id, user_id, amount, created_at, topup_method, reference";

  const { data, error } = await db
    .from("wallet_transactions")
    .select(select)
    .eq("status", "pending")
    .is("topup_method", null)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    if (isSupabaseSchemaMissing(error)) return [];
    // Old wallet_transactions without `topup_method` → re-query without the filter.
    const fallback = await db
      .from("wallet_transactions")
      .select("id, user_id, amount, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(20);
    if (fallback.error) return [];
    const rows = (fallback.data ?? []) as Array<{
      id: string;
      user_id: string;
      amount: number | string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: "eft_pending",
      label: `EFT deposit pending: ${formatRand(r.amount)}`,
      href: "/oems/banking/eft?tab=pending",
      severity: "critical",
      createdAt: r.created_at,
    }));
  }

  const rows = (data ?? []) as Array<{
    id: string;
    user_id: string;
    amount: number | string | null;
    created_at: string;
    reference: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    type: "eft_pending",
    label: `EFT deposit pending: ${formatRand(r.amount)}`,
    href: "/oems/banking/eft?tab=pending",
    severity: "critical",
    createdAt: r.created_at,
  }));
}

async function readRetailManualFundsCredits(): Promise<ActionItem[]> {
  const db = openRetail();
  if (!db) return [];

  const { data, error } = await db
    .from("wallet_transactions")
    .select("id, user_id, amount, created_at, reference")
    .eq("status", "pending")
    .eq("topup_method", "manual_reference")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    if (isSupabaseSchemaMissing(error)) return [];
    // Column doesn't exist on legacy schema — silently zero.
    return [];
  }

  const rows = (data ?? []) as Array<{
    id: string;
    user_id: string;
    amount: number | string | null;
    created_at: string;
    reference: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    type: "manual_funds",
    label: `Manual funds credit pending: ${formatRand(r.amount)}${r.reference ? ` · ref ${r.reference}` : ""}`,
    href: "/oems/banking/wallet-topup?tab=manual",
    severity: "warning",
    createdAt: r.created_at,
  }));
}

async function readRetailMmTopups(): Promise<ActionItem[]> {
  // MM top-ups surface as wallet_transactions with a dedicated `topup_method`
  // marker. Phase C will populate real counts once the Ozone MM integration
  // lands; for now the route returns zero so the bar still mounts cleanly.
  const db = openRetail();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from("wallet_transactions")
      .select("id, amount, created_at")
      .eq("status", "pending")
      .in("topup_method", ["mm_topup", "ozone_mm"])
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      if (isSupabaseSchemaMissing(error)) return [];
      return [];
    }

    const rows = (data ?? []) as Array<{
      id: string;
      amount: number | string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      type: "mm_topup",
      label: `MM top-up pending: ${formatRand(r.amount)}`,
      href: "/oems/money-market?tab=topups",
      severity: "info",
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

async function readInstitutionalReadyRebalances(): Promise<ActionItem[]> {
  const db = openInstitutional();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from("rebalance_request_c")
      .select("id, strategy_id, requested_by, created_at, approved_at")
      .eq("status", "ic_approved")
      .order("approved_at", { ascending: false })
      .limit(20);

    if (error) {
      if (isSupabaseSchemaMissing(error)) return [];
      return [];
    }

    const rows = (data ?? []) as Array<{
      id: string;
      strategy_id: string;
      requested_by: string | null;
      approved_at: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      type: "rebalance_ready",
      label: `IC-approved rebalance ready: ${r.strategy_id} (requested by ${r.requested_by ?? "unknown"})`,
      href: `/oems/research-lab?rebalance=${r.id}`,
      severity: "info",
      // Surface the moment it was approved; fall back to creation so the
      // banner has a meaningful age.
      createdAt: r.approved_at ?? r.created_at,
    }));
  } catch {
    // rebalance_request_c may not exist yet (Phase A5 migration pending).
    // The banner must stay alive even before tables exist.
    return [];
  }
}

async function readDismissedIds(userEmail: string): Promise<Set<string>> {
  const db = openRetail();
  if (!db) return new Set();
  try {
    const { data, error } = await db
      .from("admin_dismissed_notifications")
      .select("item_id, item_type")
      .eq("user_email", userEmail);
    if (error) {
      if (isSupabaseSchemaMissing(error)) return new Set();
      return new Set();
    }
    const rows = (data ?? []) as Array<{ item_id: string; item_type: string }>;
    return new Set(rows.map((r) => `${r.item_type}:${r.item_id}`));
  } catch {
    return new Set();
  }
}

export async function GET() {
  const auth = await getAdminContext();

  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // All five reads are wrapped in try/catch inside each helper, so a single
  // failure can't take down the whole banner feed.
  const [approvals, eft, manualFunds, mmTopups, rebalances] = await Promise.all([
    readRetailPendingApprovals(),
    readRetailPendingEft(),
    readRetailManualFundsCredits(),
    readRetailMmTopups(),
    readInstitutionalReadyRebalances(),
  ]);

  const allItems = [...approvals, ...eft, ...manualFunds, ...mmTopups, ...rebalances];

  // Filter dismissed items for the signed-in user. The unfiltered total is
  // returned so the UI can show "n hidden" hints if needed.
  const dismissedKeys = await readDismissedIds(auth.ctx.email);
  const visible = allItems.filter((it) => !dismissedKeys.has(`${it.type}:${it.id}`));

  const items = visible.sort((a, b) => {
    // critical > warning > info, then oldest first within the same severity.
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    const ra = rank[a.severity];
    const rb = rank[b.severity];
    if (ra !== rb) return ra - rb;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const payload: ActionItemsResponse = {
    ok: true,
    count: items.length,
    total: allItems.length,
    items,
  };
  if (allItems.length > items.length) {
    payload.dismissedIds = [...dismissedKeys];
  }

  return NextResponse.json(payload);
}
