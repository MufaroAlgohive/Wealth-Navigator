import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/rebalance/requests/[id]/orders
 *
 * Every `oems_order_audit` row booked for this rebalance (tagged with
 * `payload.rebalance_request_id` by reconcile-parked-holdings.ts /
 * book-settled-rebalance-orders.ts). This is what the Rebalances tab shows
 * for an already-executed request — the actual booked orders, still parked
 * here rather than on the Active Orderbook, until explicitly released
 * (see requests/[id]/release-to-orderbook/route.ts).
 */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let db: ReturnType<typeof createInstitutionalServiceRoleClient> | null;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch {
    db = null;
  }
  if (!db)
    return NextResponse.json({ ok: true, orders: [], notice: "INSTITUTIONAL database not configured." });

  const { data, error } = await db
    .from("oems_order_audit")
    .select("id, symbol, side, quantity, price_cents, status, source, client_account, created_at")
    .eq("payload->>rebalance_request_id", id)
    // Grouped by client first so all of one investor's lines sit together —
    // easier to eyeball the activity than interleaved by symbol.
    .order("client_account", { ascending: true })
    .order("symbol", { ascending: true });

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({ ok: true, orders: [], notice: "oems_order_audit table not migrated yet." });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, orders: data ?? [] });
}
