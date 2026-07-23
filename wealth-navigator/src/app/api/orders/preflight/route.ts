/**
 * POST /api/orders/preflight
 *
 * Auth-gated read-only pre-trade gate. Wraps `preflight()` from the
 * core `src/lib/orders/` module — the same helper the UAT single-order
 * and bulk send-to-market routes use internally.
 *
 * Body: {
 *   account_code: string,        // optional; defaults to env IRESS_ACCOUNT_CODE || "56378"
 *   symbol:       string,
 *   side:         "buy" | "sell",
 *   qty:          number,
 *   price_cents?: number | null, // omit/0 = market order
 *   source:       OrderSource,   // "BLOTTER_NEW_ORDER" | "RESEARCH_LAB_THESIS" | ...
 *   book_id?:     string,
 * }
 *
 * Returns the `PreflightResult` shape verbatim. A non-pass verdict
 * means the caller MUST NOT proceed to `submitOrder` — the UI opens the
 * `<GuardrailForceCorrectionDialog/>` and lets the trader correct.
 *
 * Used by:
 *   - `/oems/blotter` `NewOrderDialog` (real-data mode)
 *   - Future: research-lab → submit thesis, paper-model rebalance button,
 *     admin blotter.
 *
 * See plan §2 (BFF routes → thin auth wrappers) and §3 (shared modal).
 */

import { NextResponse } from "next/server";

import { isIressWorkerConfigured } from "@/lib/data-policy";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";
import { preflight } from "@/lib/orders";
import type { OrderSide, OrderSource, PreflightResult } from "@/lib/orders";

export const dynamic = "force-dynamic";

const VALID_SOURCES: OrderSource[] = [
  "BLOTTER_NEW_ORDER",
  "RESEARCH_LAB_THESIS",
  "PAPER_MODEL_REBALANCE",
  "UAT_ADHOC_ORDER",
  "OB_SEND_TO_MARKET_UAT",
  "IRESS",
];

const VALID_SIDES: OrderSide[] = ["buy", "sell"];

export async function POST(req: Request) {
  // Auth gate — any authenticated user can preflight (the /oems/blotter
  // surface is the live desk, not admin-only). Sessions are checked
  // implicitly: the cookie store throws when unauthenticated.
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Number(body.qty);
  const priceCentsRaw = body.price_cents;
  const priceCents =
    priceCentsRaw != null && Number.isFinite(Number(priceCentsRaw)) && Number(priceCentsRaw) > 0
      ? Math.round(Number(priceCentsRaw))
      : null;
  const source = String(body.source ?? "BLOTTER_NEW_ORDER") as OrderSource;
  const bookId = typeof body.book_id === "string" ? body.book_id : undefined;

  if (!symbol) {
    return NextResponse.json({ ok: false, error: "`symbol` is required" }, { status: 400 });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ ok: false, error: "`qty` must be a positive number" }, { status: 400 });
  }
  if (!VALID_SIDES.includes(side)) {
    return NextResponse.json({ ok: false, error: "`side` must be 'buy' or 'sell'" }, { status: 400 });
  }
  if (!VALID_SOURCES.includes(source)) {
    return NextResponse.json(
      {
        ok: false,
        error: `\`source\` must be one of ${VALID_SOURCES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Default to the desk IRESS account — the public blotter orders all
  // route to the shared omnibus account today. Future per-client routing
  // (IRESS_PER_CLIENT_GUARD on) will derive this from the auth session.
  // Production must set `IRESS_ACCOUNT_CODE`; absence is a configuration
  // error and we refuse to submit against a UAT fallback.
  const accountCode =
    typeof body.account_code === "string" && body.account_code.trim().length > 0
      ? body.account_code.trim()
      : process.env.IRESS_ACCOUNT_CODE?.trim();

  if (!accountCode) {
    return NextResponse.json(
      {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "iress_account_unconfigured",
        message:
          "IRESS_ACCOUNT_CODE is not set. Production must set IRESS_ACCOUNT_CODE explicitly (no UAT fallback); set it in Vercel + Railway env.",
      },
      { status: 503 },
    );
  }

  // Even when the worker is offline we want to honour the local fallback
  // (mirrors the worker's `availableToSell` / `availableToBuy`).
  if (!isIressWorkerConfigured()) {
    // Make sure the local fallback has its DB configured before we promise
    // the caller a verdict.
    try {
      createInstitutionalServiceRoleClient();
    } catch {
      const blocked: PreflightResult = {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "sell_guard_unavailable",
        message:
          "Preflight unreachable: worker not configured and INSTITUTIONAL Supabase not configured; cannot verify the order.",
      };
      return NextResponse.json(blocked, { status: 503 });
    }
  }

  const result = await preflight({
    account_code: accountCode,
    symbol,
    side,
    qty: Math.floor(qty),
    price_cents: priceCents,
    source,
    book_id: bookId,
  });

  // 422 for blocked, 200 for pass. Matches the worker endpoint contract.
  const status = result.ok ? 200 : 422;
  return NextResponse.json(result, { status });
}
