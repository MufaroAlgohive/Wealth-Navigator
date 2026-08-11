import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { isUatEnv } from "@/lib/oems/uat-scope";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/requests/[id]/push
 *
 * Trigger execution of an IC-approved rebalance request.
 *
 * Validates:
 *  - the request exists and is in status='ic_approved'
 *  - the caller has `rebalance/push_rebalance` (admin tier)
 *
 * Writes:
 *  - one row per affected holding into `oems_order_audit` (status='working')
 *  - the request itself → status='executed' with `executed_at = now()`
 *
 * Read-only fallback: returns 200 with `{ orders: [], notice }` when the
 * institutional schema isn't migrated yet so the UI can render an honest
 * empty state instead of crashing.
 */

export const dynamic = "force-dynamic";

interface RebalanceRow {
  id: string;
  strategy_id: string;
  requested_by: string;
  current_composition: unknown;
  proposed_composition: unknown;
  affected_investors: unknown | null;
  status: string;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProposedRow {
  symbol?: string;
  ticker?: string;
  shares?: number;
  weight?: number;
  action?: "remove" | "decrease" | "increase" | "add" | "hold";
}

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!canResearchIc(auth.ctx, "rebalance", "push_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = await openDb();
  if (!db) {
    return NextResponse.json({
      ok: true,
      orders: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  const requestRes = await db
    .from("rebalance_request_c")
    .select(
      "id, strategy_id, requested_by, current_composition, proposed_composition, affected_investors, status, research_note_id, executed_at, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (requestRes.error) {
    if (isSupabaseSchemaMissing(requestRes.error)) {
      return NextResponse.json({
        ok: true,
        orders: [],
        notice: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: requestRes.error.message }, { status: 500 });
  }

  /* DISABLED 2026-07-27. This route has never produced a single order row —
     `oems_order_audit` has zero rows with source='rebalance_request' — and it
     cannot safely produce one:

       - `client_account: request.strategy_id` puts a STRATEGY NAME where a
         client belongs, and no payload.user_id is stamped at all, so a fill
         could never be attributed or settled to anybody.
       - `shares` comes from `proposed_composition`, which is the strategy MODEL
         template built from strategies_c.holdings — not any client's position.
         It is neither a per-client quantity nor an aggregate of them.
       - `affected_investors` is selected above and then never read. The builder
         does not even send it, so it is null on every row.
       - Nothing dispatches the `working` rows it writes. The only other reader
         is broker-ingest's MOCK fill synthesiser, so the rows would sit forever.

     And it is reachable: it accepts any request in `ic_approved`, of which
     there are 21 in the live INSTITUTIONAL database right now — all written by
     send-to-market as an AUDIT MIRROR of a book that was already dispatched.
     POSTing here against any of them would emit a second, unattributable set of
     orders for work already sent.

     The real basket path is POST /api/admin/orderbook/send-to-market, which
     reads stock_holdings_c and emits one order per client lot.

     Refusing rather than deleting: the IC approval flow that feeds this is real
     and someone will want to wire execution to it properly. Failing loudly with
     the reason is more useful to that person than a silently missing route. */
  return NextResponse.json(
    {
      ok: false,
      deferred: true,
      error:
        "Rebalance push is disabled. This route emits orders with a strategy name in place of a client " +
        "and no user_id, so their fills can never be settled — and nothing dispatches them. Use " +
        "POST /api/admin/orderbook/send-to-market, which emits one order per client lot.",
    },
    { status: 501 },
  );
}
