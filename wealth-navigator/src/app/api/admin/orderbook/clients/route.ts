import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/orderbook/clients
 *
 * Client picker for the Manual Client Order ticket.
 *
 * Returns every MINT client the desk can place a manual order for, with the
 * two numbers that decide whether an order is even possible: their available
 * cash and, when `?symbol=` is supplied, how many of that security they hold.
 *
 * The dealer sees the constraint BEFORE typing a quantity, rather than
 * discovering it as a 422 after clicking place. The authoritative check still
 * runs in the worker's pre-trade guard at release time — this is the same
 * arithmetic surfaced early, never a substitute for it.
 *
 * Nothing here reaches a broker. LONGMARK never receives client identity: it
 * only ever sees the MINT account. The client linkage lives entirely in our own
 * audit row so we can do the breakdown internally.
 */

export const dynamic = "force-dynamic";

interface ClientRow {
  user_id: string;
  name: string;
  email: string | null;
  mint_number: string | null;
  is_test: boolean;
  available_cash_rands: number | null;
  wallet_status: string | null;
  /** Only populated when ?symbol= is supplied. */
  holds_qty: number | null;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let retail: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    retail = createRetailServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `retail database unavailable: ${(e as Error).message}` },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();

  const { data: profiles, error: profErr } = await retail
    .from("profiles")
    .select("id, first_name, last_name, email, mint_number, is_test")
    .order("first_name", { ascending: true });
  if (profErr) {
    return NextResponse.json({ ok: false, error: profErr.message }, { status: 500 });
  }

  const { data: wallets } = await retail.from("wallets").select("user_id, balance, status");
  const walletBy = new Map(
    (wallets ?? []).map((w) => [
      (w as { user_id: string }).user_id,
      w as { balance: number | null; status: string | null },
    ]),
  );

  // Position lookup for the chosen security, so a SELL ticket can show what the
  // client can actually sell. Open lots only — a closed lot is not sellable.
  const heldBy = new Map<string, number>();
  if (symbol) {
    const bare = symbol.replace(/\.(JO|JSE)$/i, "");
    const { data: sec } = await retail
      .from("securities_c")
      .select("id")
      .in("symbol", [bare, `${bare}.JO`, `${bare}.JSE`])
      .limit(1)
      .maybeSingle();
    const securityId = sec ? (sec as { id: string }).id : null;
    if (securityId) {
      const { data: holdings } = await retail
        .from("stock_holdings_c")
        .select("user_id, quantity")
        .eq("security_id", securityId)
        .eq("is_active", true);
      for (const h of holdings ?? []) {
        const row = h as { user_id: string; quantity: number | null };
        heldBy.set(row.user_id, (heldBy.get(row.user_id) ?? 0) + Number(row.quantity ?? 0));
      }
    }
  }

  const clients: ClientRow[] = (profiles ?? []).map((p) => {
    const row = p as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      mint_number: string | null;
      is_test: boolean | null;
    };
    const w = walletBy.get(row.id);
    const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
    return {
      user_id: row.id,
      name: name || row.email || row.id.slice(0, 8),
      email: row.email,
      mint_number: row.mint_number,
      is_test: row.is_test === true,
      // wallets.balance is RANDS in the retail schema (not cents) — the
      // per-client buy guard reads the same column and compares it directly
      // against a Rand order value.
      available_cash_rands: w?.balance != null ? Number(w.balance) : null,
      wallet_status: w?.status ?? null,
      holds_qty: symbol ? (heldBy.get(row.id) ?? 0) : null,
    };
  });

  return NextResponse.json({
    ok: true,
    symbol: symbol || null,
    count: clients.length,
    clients,
  });
}
