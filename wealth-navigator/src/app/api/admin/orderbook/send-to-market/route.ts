import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";
import { isUatEnv, uatModeEnabled } from "@/lib/oems/uat-scope";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * Pre-trade strategy-level limit guard (2026-07-14, transcript gap
 * "We bought 100, sold 50, then sold 75 — broker didn't block the 75").
 *
 * The IRESS IOS+ OrderPad does NOT enforce portfolio limits — Andre
 * confirmed during the UAT walkthrough (2026-07-14, 28:22-34:32) that
 * the desk expects MY side to gate:
 *
 *   - BUY  : notional must fit within available cash at the desk
 *            account (oems_account_c.cash_balance minus outstanding
 *            buy notional from in-flight orders).
 *   - SELL : must not exceed current position + outstanding buys in
 *            flight (i.e. no naked shorts).
 *
 * Scope: runs against the *aggregate strategy book* against the desk's
 * IRESS AccountCode (env IRESS_ACCOUNT_CODE, default "56378" for UAT).
 * Per-investor enforcement is deferred until the mint_number ↔
 * AccountCode bridge lands (post-OEMS v1, AGENTS.md).
 *
 * The guard fails closed: any violation returns 422 with the offending
 * holdings + the reason. The audit rows are NOT written in that case.
 *
 * Two-state contract surfaced on every successful audit row:
 *   payload.limits_enforced    = true  → guard ran + passed
 *   payload.limits_checked_at  = ISO timestamp
 *   payload.limits_snapshot    = { available_cash, account_code,
 *     positions[], in_flight[] } for forensic replay
 *
 * When the guard CAN'T run (no oems_account_c row, no last_price, etc.)
 * we still write the audit rows but stamp limits_enforced=false + a
 * reason so the operator sees the gap rather than believing the trade
 * was validated.
 */

/**
 * POST /api/admin/orderbook/send-to-market
 *
 * Mint OEM Phase B3 — dispatches a book of orders to the broker by writing
 * one execution row per ISIN into `oems_order_audit` (status='working') and,
 * when the table is migrated, raising a paired `rebalance_request_c` row
 * (status='ic_approved') so the desk has a paper trail for downstream
 * confirmation.
 *
 * Body: { book_id: string, broker: string, order_type: "limit" | "market" }
 * Returns: { ok, execution_ids, rebalance_id?, notice?, mode?, uat?: ... }
 *
 * Business rule (Lonwabo): limit must be > 0. If the book contains ISINs
 * without a recorded `expectedFill` and the order_type is "limit", we reject
 * with 400 — the dealer must capture limits first.
 *
 * Degradation: `rebalance_request_c` may not be migrated yet (Phase A5).
 * The handler treats a 42P01 as a soft failure and still writes the
 * `oems_order_audit` rows so the desk can dispatch. The response carries
 * `rebalance_id: null` and a `notice` describing the fallback.
 *
 * Phase UAT (Mint OEM Finalisation): when `IRESS_UAT_MODE=true` AND the
 * Railway worker is configured (`IRESS_WORKER_URL` set), the handler
 * fans out to the worker's `POST /uat/send-to-market` AFTER writing the
 * audit rows. The worker calls IRESS `OrderCreate3` on the MINT_CT IOS
 * seat and stamps the broker `OrderNumber` back onto each row. The
 * audit-write path is the source of truth either way — the worker
 * call is additive (`mode: "uat"` vs `mode: "audit-only"`).
 */

export const dynamic = "force-dynamic";

interface Holding {
  id: string;
  user_id: string;
  security_id: string;
  quantity: number;
  avg_fill: number | null;
  Expected_fill: number | null;
  trade_side: string;
  strategy_name_snapshot: string | null;
}

interface Security {
  id: string;
  symbol: string;
  name: string | null;
  isin: string | null;
  last_price: number | null;
}

interface Profile {
  id: string;
  email: string | null;
  is_test: boolean | null;
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

interface WorkerUatResponse {
  ok: boolean;
  iressOrderNumber?: string;
  status?: string;
  orderAuditId?: string;
  accountCode?: string;
  brokerDestination?: string;
  errorNumber?: number;
  errorDescription?: string;
}

// ─── Pre-trade limit guard types ───────────────────────────────────────
interface AccountSnapshot {
  account_code: string;
  cash_balance: number | null;
  nav_value: number | null;
  account_status: string | null;
}
interface PositionSnapshot {
  security_code: string;
  quantity: number;
}
interface InFlightOrder {
  security_code: string;
  symbol: string;
  side: "buy" | "sell";
  /** Original full order quantity (audit row `quantity`). */
  quantity: number;
  /**
   * Quantity already filled on the broker side (audit row
   * `payload->>'filled'`). 0 when the poller hasn't stamped any fill yet.
   * The reservation math uses `remaining` (= max(0, quantity − filled)),
   * not `quantity`, so partial fills don't over-reserve (2026-07-20 fix).
   */
  filled: number;
  remaining: number;
  price_cents: number | null;
  // Approx notional in Rands for cash-availability math (uses limit
  // when available, otherwise the row's avgPx, otherwise null). Scaled
  // to `remaining` shares, not the full `quantity` (2026-07-20 fix).
  notionalRands: number | null;
  order_id: string;
}
interface LimitViolation {
  holding_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  reason: string;
  // Detail for the operator tooltip.
  detail: Record<string, number | string | null>;
}
interface LimitSnapshot {
  account_code: string;
  available_cash: number | null;
  positions: Array<{ security_code: string; quantity: number }>;
  in_flight: Array<{
    symbol: string;
    side: string;
    quantity: number;
    filled: number;
    remaining: number;
    notional_rands: number | null;
  }>;
}
interface LimitGuardResult {
  enforced: boolean;
  violations: LimitViolation[];
  snapshot: LimitSnapshot | null;
  // Human-readable reason the guard could not run (null when enforced).
  skipReason: string | null;
}

// Statuses we treat as "in flight" (i.e. committed against the limit).
// Filled / cancelled / expired / rejected / failed are terminal — they
// already hit (or settled at) the broker and are reflected in the IPS
// position snapshot.
const IN_FLIGHT_STATUSES = new Set([
  "pending_ack",
  "acknowledged",
  "working",
  "partial",
  "amend_pending",
  "cancel_pending",
]);

/**
 * Run the pre-trade strategy-level limit guard for a book of holdings
 * against the desk's IRESS AccountCode (env IRESS_ACCOUNT_CODE, default
 * "56378"). Reads positions + cash + outstanding orders from the
 * institutional Supabase. Returns `{ enforced, violations, snapshot,
 * skipReason }` — `enforced=false` means the guard could not run (no
 * account row, missing price data, etc.) and the caller must stamp the
 * audit row with `limits_enforced: false` so the operator sees the gap.
 */
// Exported for tests (regression coverage on the partial-fill reservation fix).
// Not a public API — only consumed by `src/__tests__/runLimitGuard.test.ts`.
export async function runLimitGuard(
  institutional: SupabaseClient,
  accountCode: string,
  holdings: Holding[],
  secMap: Record<string, Security>,
  orderType: "limit" | "market",
): Promise<LimitGuardResult> {
  // 1. Account snapshot (cash + nav + status).
  const { data: acctRow } = await institutional
    .from("oems_account_c")
    .select("account_code, cash_balance, nav_value, account_status")
    .eq("account_code", accountCode)
    .maybeSingle();
  const account = (acctRow ?? null) as AccountSnapshot | null;
  if (!account) {
    return {
      enforced: false,
      violations: [],
      snapshot: null,
      skipReason: `No oems_account_c row for account_code=${accountCode} — IPS worker must ingest IPSAccountGetAll1 first.`,
    };
  }
  if (account.account_status && !["OPEN", "ACTIVE", "MARGIN"].includes(account.account_status.toUpperCase())) {
    return {
      enforced: false,
      violations: [],
      snapshot: { account_code: accountCode, available_cash: account.cash_balance, positions: [], in_flight: [] },
      skipReason: `Account ${accountCode} status is '${account.account_status}' — guard refused to run.`,
    };
  }

  // 2. Positions snapshot for the desk account.
  // 2026-07-15: indexed by BOTH the raw IRESS security_code (e.g.
  // `SOL.JO`) AND a suffix-stripped version (e.g. `SOL`). The retail
  // `securities_c.symbol` may not carry the `.JO` exchange suffix while
  // the IPS worker writes whatever IRESS returned. Without the
  // suffix-tolerant lookup, the naked-short check sees `cur=0` for the
  // holding's symbol and lets a sell through even though the broker
  // already confirms the position.
  const { data: posRows } = await institutional
    .from("oems_position_c")
    .select("security_code, quantity")
    .eq("account_code", accountCode);
  const stripExchangeSuffix = (s: string): string =>
    s.replace(/\.(JO|ZA|JSE|LON|NAS|NYSE|ASX|LSE|TYO|HKG|AMS|PAR|FRA|MIL|MAD)\b/i, "");
  const positions = ((posRows ?? []) as PositionSnapshot[]).reduce<Map<string, number>>(
    (m, p) => {
      const raw = p.security_code;
      const stripped = stripExchangeSuffix(raw);
      const q = Number(p.quantity) || 0;
      m.set(raw, q);
      if (stripped !== raw) m.set(stripped, q);
      return m;
    },
    new Map(),
  );

  // 3. In-flight orders for the desk account.
  // 2026-07-15: previously filtered on `.eq("client_account", accountCode)`
  // which only matched worker poll rows (those carry the IRESS account
  // code in `client_account`). BFF send-to-market seeds used the MINT
  // user email there, so we never saw them in this snapshot — meaning
  // outstanding buys/sells were never netted against current positions
  // for the cash + naked-short math. We OR'd in
  // `payload->>broker_account_code.eq.accountCode` to pick up BFF seed
  // rows that route through this same desk account.
  // 2026-07-20: the new typed `broker_account_code` column supersedes the
  // JSON workaround — every BFF-seeded row now stamps the IRESS AccountCode
  // on the typed column directly (see `src/lib/orders/submit.ts`), and the
  // worker poll mapper stamps it too (`workers/iress-ingest/src/orders.ts`).
  // The migration `20260720000001_oems_order_audit_broker_account.sql`
  // backfilled legacy rows. So we filter on the typed column only.
  const { data: ooRows } = await institutional
    .from("oems_order_audit")
    .select("order_id, symbol, side, quantity, price_cents, status, payload")
    .eq("broker_account_code", accountCode)
    .in("status", Array.from(IN_FLIGHT_STATUSES));
  const inFlight: InFlightOrder[] = ((ooRows ?? []) as Array<{
    order_id: string;
    symbol: string;
    side: string;
    quantity: number;
    price_cents: number | null;
    payload: Record<string, unknown> | null;
  }>).map((r) => {
    // Notional = price_cents/100 * REMAINING shares (Rands). Falls back to
    // payload.avgPx / payload.limitPrice. null when no usable price.
    // 2026-07-20 fix: was full `quantity` — partial fills over-reserved.
    const qty = Number(r.quantity) || 0;
    const filled = Number((r.payload as { filled?: number } | null)?.filled) || 0;
    const remaining = Math.max(0, qty - filled);
    const pxCents =
      r.price_cents ??
      (typeof r.payload?.avgPx === "number" ? Math.round(Number(r.payload.avgPx) * 100) : null) ??
      (typeof r.payload?.limitPrice === "number" ? Math.round(Number(r.payload.limitPrice) * 100) : null);
    const notional = pxCents != null ? (pxCents / 100) * remaining : null;
    return {
      order_id: r.order_id,
      security_code: r.symbol,
      symbol: r.symbol,
      side: r.side === "sell" ? "sell" : "buy",
      quantity: qty,
      filled,
      remaining,
      price_cents: r.price_cents,
      notionalRands: notional,
    };
  });

  const availableCash =
    account.cash_balance != null
      ? Math.max(0, Number(account.cash_balance)) -
        // 2026-07-20: reserve by `remaining * px`, not `quantity * px`,
        // so a partial fill on an existing buy doesn't over-reserve cash.
        inFlight
          .filter((o) => o.side === "buy")
          .reduce((s, o) => s + (o.notionalRands ?? 0), 0)
      : null;

  const snapshot: LimitSnapshot = {
    account_code: accountCode,
    available_cash: availableCash,
    positions: Array.from(positions.entries()).map(([security_code, quantity]) => ({ security_code, quantity })),
    in_flight: inFlight.map((o) => ({
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      filled: o.filled,
      remaining: o.remaining,
      notional_rands: o.notionalRands,
    })),
  };

  // 4. Validate each holding against the snapshot. First failure is
  // fatal (atomic dispatch — we don't partial-send a book).
  const violations: LimitViolation[] = [];
  // Track the running position / cash projection across the book so
  // intra-book sells/buys don't double-count against the snapshot.
  const projectedCash: { value: number | null } = { value: availableCash };
  const projectedPositions = new Map(positions);

  for (const h of holdings) {
    const sec = secMap[h.security_id];
    const symbol = sec?.symbol ?? "—";
    const qty = Number(h.quantity) || 0;
    if (qty <= 0) {
      violations.push({
        holding_id: h.id,
        symbol,
        side: h.trade_side === "sell" ? "sell" : "buy",
        qty,
        reason: "Quantity must be > 0",
        detail: {},
      });
      continue;
    }

    if (h.trade_side === "sell") {
      // No naked short: current position + outstanding buys in flight must
      // cover the sell. The orderbook audit table tracks in-flight orders;
      // oems_position_c carries the broker-confirmed position.
      //
      // 2026-07-15: matched on BOTH the raw holding symbol and the
      // suffix-stripped variant so we cover the case where retail
      // `securities_c.symbol` lacks the IRESS `.JO` exchange suffix but
      // the in-flight rows have it (or vice versa).
      const symbolStripped = stripExchangeSuffix(symbol);
      const cur = projectedPositions.get(symbol) ?? projectedPositions.get(symbolStripped) ?? 0;
      const ooBuy = inFlight
        .filter((o) => {
          if (o.side !== "buy") return false;
          return o.security_code === symbol || stripExchangeSuffix(o.security_code) === symbolStripped;
        })
        // 2026-07-20 fix: reserve by `remaining` (qty − filled), not the full
        // `quantity`. A partial-fill order that still has 60/150 shares left
        // should only reserve 60 against the next sell, not 150.
        .reduce((s, o) => s + o.remaining, 0);
      const ooSell = inFlight
        .filter((o) => {
          if (o.side !== "sell") return false;
          return o.security_code === symbol || stripExchangeSuffix(o.security_code) === symbolStripped;
        })
        .reduce((s, o) => s + o.remaining, 0);
      const effectivePosition = cur + ooBuy - ooSell;
      if (qty > effectivePosition) {
        violations.push({
          holding_id: h.id,
          symbol,
          side: "sell",
          qty,
          reason: `Would create a net short of ${qty - effectivePosition} shares — broker does not block naked shorts; this guard refused.`,
          detail: {
            current_position: cur,
            outstanding_buys: ooBuy,
            outstanding_sells: ooSell,
            effective_cover: effectivePosition,
            short_fall: qty - effectivePosition,
          },
        });
        continue;
      }
      // Project: subtract the sell from the running position.
      projectedPositions.set(symbol, cur - qty);
    } else {
      // BUY: notional must fit within available cash at limit (or last price).
      const pxRands =
        orderType === "limit" && Number.isFinite(Number(h.Expected_fill)) && Number(h.Expected_fill) > 0
          ? Number(h.Expected_fill) / 100
          : sec?.last_price != null
            ? Number(sec.last_price) / 100
            : null;
      if (pxRands == null || !Number.isFinite(pxRands) || pxRands <= 0) {
        violations.push({
          holding_id: h.id,
          symbol,
          side: "buy",
          qty,
          reason: `No usable price for cash check (limit=${h.Expected_fill ?? "null"}, last_price=${sec?.last_price ?? "null"})`,
          detail: {},
        });
        continue;
      }
      const notional = pxRands * qty;
      if (projectedCash.value != null && projectedCash.value < notional) {
        violations.push({
          holding_id: h.id,
          symbol,
          side: "buy",
          qty,
          reason: `Notional ${notional.toFixed(2)} exceeds available cash ${projectedCash.value.toFixed(2)} (account ${accountCode}, minus in-flight BUY notional).`,
          detail: {
            unit_price: pxRands,
            notional: notional,
            available_cash: projectedCash.value,
            shortfall: notional - projectedCash.value,
          },
        });
        continue;
      }
      // Project: deduct the notional from cash + add qty to the projected position.
      if (projectedCash.value != null) {
        projectedCash.value = projectedCash.value - notional;
      }
      const cur = projectedPositions.get(symbol) ?? 0;
      projectedPositions.set(symbol, cur + qty);
    }
  }

  return {
    enforced: violations.length === 0,
    violations,
    snapshot,
    skipReason: null,
  };
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bookId = typeof body.book_id === "string" ? body.book_id.trim() : "";
  const broker = typeof body.broker === "string" ? body.broker.trim() : "";
  const orderType = body.order_type === "market" ? "market" : "limit";
  // UAT escape hatch — only honoured when IRESS_UAT_MODE is set on Vercel.
  // When false, the audit rows are still written but the worker is never
  // called (existing audit-only path is preserved bit-for-bit).
  //
  // uatModeEnabled() accepts "1" as well as "true". The strict === "true" this
  // replaces was the single highest-consequence instance of the mismatch: the
  // Railway worker's own 403 says "set IRESS_UAT_MODE=1", so following that
  // instruction turned UAT on at the worker while THIS line silently fell back
  // to audit-only. Orders would be accepted in the UI, stamped in the audit
  // table, and never reach a market — with no error raised anywhere.
  const uatTest = body.uat_test === true && uatModeEnabled();

  if (!bookId) return NextResponse.json({ ok: false, error: "book_id is required" }, { status: 400 });
  if (!broker) return NextResponse.json({ ok: false, error: "broker is required" }, { status: 400 });
  if (orderType !== "limit" && orderType !== "market") {
    return NextResponse.json({ ok: false, error: "order_type must be 'limit' or 'market'" }, { status: 400 });
  }

  // The "book" is logically a per-user set of holdings tied to a strategy.
  // book_id is the strategy_name_snapshot (the grouping key) today — once
  // a dedicated `order_book_c` table exists we'll switch. Resolve the rows
  // from the RETAIL `stock_holdings_c` audit mirror.
  const retail = await (async (): Promise<SupabaseClient | null> => {
    try {
      const { createRetailServiceRoleClient } = await import("@/lib/supabase/server");
      return createRetailServiceRoleClient();
    } catch {
      return null;
    }
  })();

  if (!retail) {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const { data: holds, error: holdsErr } = await retail
    .from("stock_holdings_c")
    .select("id, user_id, security_id, quantity, avg_fill, Expected_fill, trade_side, strategy_name_snapshot")
    .eq("strategy_name_snapshot", bookId)
    .eq("is_active", true);

  if (holdsErr) {
    return NextResponse.json({ ok: false, error: holdsErr.message }, { status: 500 });
  }

  const holdings = (holds ?? []) as Holding[];
  if (holdings.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No active holdings found for that book_id." },
      { status: 404 },
    );
  }

  // Validate limits if order_type=limit (must be > 0 cents).
  if (orderType === "limit") {
    const missing = holdings.filter(
      (h) => !Number.isFinite(Number(h.Expected_fill)) || Number(h.Expected_fill) <= 0,
    );
    if (missing.length) {
      return NextResponse.json(
        {
          ok: false,
          error: `Limit price must be > 0. ${missing.length} holding(s) have no recorded expected fill.`,
          missing_ids: missing.map((h) => h.id),
        },
        { status: 400 },
      );
    }
  }

  // Resolve securities + accounts for the execution rows.
  const secIds = [...new Set(holdings.map((h) => h.security_id).filter(Boolean))];
  const userIds = [...new Set(holdings.map((h) => h.user_id).filter(Boolean))];

  const [{ data: secs }, { data: profs }, { data: testWallets }] = await Promise.all([
    retail.from("securities_c").select("id, symbol, name, isin, last_price").in("id", secIds),
    retail.from("profiles").select("id, email, is_test").in("id", userIds),
    retail.from("wallets").select("user_id").eq("status", "test").in("user_id", userIds),
  ]);

  const secMap: Record<string, Security> = {};
  for (const s of (secs ?? []) as Security[]) secMap[s.id] = s;
  const profMap: Record<string, Profile> = {};
  for (const p of (profs ?? []) as Profile[]) profMap[p.id] = p;
  // Dual test classifier: profiles.is_test OR wallets.status='test'. Some test
  // accounts are flagged only on the wallet.
  const testUserIds = new Set<string>();
  for (const p of (profs ?? []) as Profile[]) if (p.is_test === true) testUserIds.add(p.id);
  for (const w of (testWallets ?? []) as Array<{ user_id: string | null }>) if (w.user_id) testUserIds.add(w.user_id);

  // CLIENT-DATA GUARD (UAT phase): a UAT dispatch fans real orders out to IRESS.
  // During the UAT phase, refuse fail-closed if the resolved book contains any
  // real (is_test != true) client — a UAT run must never send a real client's
  // order to the broker. This enforces the desk rule "keep it on UAT" and the
  // hard boundary "do not touch the live DB with real client data". Inert once
  // the deployment is confidently on prod (isUatEnv() === false).
  if (uatTest && isUatEnv()) {
    const realOwners = [...new Set(holdings.map((h) => h.user_id).filter(Boolean))].filter(
      (uid) => !testUserIds.has(uid),
    );
    if (realOwners.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `Refused: this UAT dispatch resolves ${realOwners.length} real (non-test) client holding(s) for book '${bookId}'. UAT dispatches must contain only test clients (profiles.is_test=true or wallets.status='test') — use a UAT-* test book.`,
        },
        { status: 422 },
      );
    }
  }

  const institutional = openInstitutional();
  if (!institutional) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  // ── Pre-trade limit guard ───────────────────────────────────────────
  // (2026-07-14) Refuse the dispatch when ANY holding would create a
  // naked short or bust available cash. The IRESS IOS+ OrderPad does
  // not enforce these — the desk confirmed during UAT walkthrough
  // (28:22-34:32) that we are responsible for limits.
  //
  // Per-investor enforcement is post-OEMS v1 (mint_number ↔ AccountCode
  // bridge). For now the guard runs against the aggregate strategy
  // book against the desk's IRESS AccountCode. `IRESS_ACCOUNT_CODE`
  // MUST be set on production; absence below is a configuration error
  // and the guard call will throw with a clear message.
  const deskAccountCode =
    typeof process.env.IRESS_ACCOUNT_CODE === "string" && process.env.IRESS_ACCOUNT_CODE.trim().length > 0
      ? process.env.IRESS_ACCOUNT_CODE.trim()
      : undefined;
  if (!deskAccountCode) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "IRESS_ACCOUNT_CODE is not set. Production must set IRESS_ACCOUNT_CODE explicitly (no UAT fallback); set it in Vercel + Railway env.",
      },
      { status: 503 },
    );
  }
  const guard = await runLimitGuard(institutional, deskAccountCode, holdings, secMap, orderType);
  // 2026-07-15: stamp the timestamp at the top so we can echo it on
  // every audit row AND on the 422 response when the guard blocks.
  const limitsCheckedAt = new Date().toISOString();

  // 2026-07-15 (Andre + Juan, transcript 13:40-14:08): the original
  // code only checked `guard.violations` inside the `if (!guard.enforced)`
  // branch. When the guard ran successfully (had data + status) AND found
  // a violation, the dispatch fell through and the audit rows were
  // written — naked shorts + cash busts leaked to Hermes. The fix:
  // violation check runs unconditionally; the `enforced=false` distinction
  // is only about whether the guard had enough data to compute risk.
  if (guard.violations.length > 0) {
    console.warn(
      `[orderbook/send-to-market] limit guard BLOCKED dispatch for book=${bookId} ` +
        `account=${deskAccountCode} enforced=${guard.enforced} ` +
        `violations=${guard.violations.length} ` +
        `first=${JSON.stringify(guard.violations[0])}`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: "Pre-trade limit guard refused the dispatch.",
        code: "limit_guard_violation",
        account_code: deskAccountCode,
        enforced: guard.enforced,
        // Per-holding violations + the position/cash snapshot the guard
        // saw, so the operator can replay the math in the audit row.
        violations: guard.violations,
        snapshot: guard.snapshot,
        guard_verdict: {
          enforced: guard.enforced,
          blocked: true,
          checked_at: limitsCheckedAt,
          violation_count: guard.violations.length,
          skip_reason: guard.enforced ? null : (guard.skipReason ?? null),
        },
      },
      { status: 422 },
    );
  }
  if (!guard.enforced) {
    // 2026-07-16: FAIL CLOSED for SELLS. IRESS does not validate oversells
    // (iress-v4-docs/11-mint-oems) and the guard's position feed (IPS
    // oems_position_c) is often empty, so the old "log and continue" path let
    // a sell we can't prove coverage for reach the broker — a possible naked
    // short. If the book contains ANY sell and the guard could not run, refuse
    // the dispatch. (BUY-only books still proceed with limits_enforced=false —
    // a cash-feed gap shouldn't halt legitimate buying, and an overspend is a
    // settlement issue, not a naked short; the naked-short case is the sell.)
    const hasSell = holdings.some((h) => (h.trade_side ?? "").toLowerCase() === "sell");
    if (hasSell) {
      console.warn(
        `[orderbook/send-to-market] limit guard could not verify a SELL book=${bookId} account=${deskAccountCode}: ${guard.skipReason ?? "unknown"} — BLOCKING (fail-closed)`,
      );
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sell dispatch blocked: holdings could not be verified for this account, so we can't confirm the shares are held. Ingest positions (IPS) for this account, or dispatch a sell only once coverage is provable.",
          code: "limit_guard_unverified_sell",
          account_code: deskAccountCode,
          enforced: false,
          skip_reason: guard.skipReason ?? null,
          guard_verdict: { enforced: false, blocked: true, checked_at: limitsCheckedAt },
        },
        { status: 422 },
      );
    }
    console.warn(
      `[orderbook/send-to-market] limit guard SKIPPED (buy-only book) for book=${bookId}: ${guard.skipReason ?? "unknown"}`,
    );
  }

  // Build execution rows (one per ISIN per holding). order_id is the strategy
  // book so the desk can group/aggregate on the front-end.
  // limitsCheckedAt was declared above so we can echo it in the 422
  // response too (the timestamp is the same for the guard verdict).
  const executionRows = holdings.map((h, idx) => {
    const sec = secMap[h.security_id];
    const prof = profMap[h.user_id];
    const limitRands = orderType === "limit" ? Number(h.Expected_fill ?? 0) / 100 : 0;
    const orderId = `OB-${bookId}-${Date.now().toString(36)}-${idx}`;
    return {
      order_id: orderId,
      client_account: prof?.email ?? h.user_id,
      // 2026-07-20: stamp the typed `broker_account_code` column too so
      // downstream queries (runLimitGuard, worker preflight) can filter
      // directly without the legacy `payload->>` workaround. The
      // `payload.broker_account_code` mirror stays for backwards-compat.
      broker_account_code: deskAccountCode,
      symbol: sec?.symbol ?? "—",
      side: (h.trade_side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
      quantity: Number(h.quantity) || 0,
      price_cents: orderType === "limit" ? Math.round(limitRands * 100) : null,
      status: "working",
      source: uatTest ? "OB_SEND_TO_MARKET_UAT" : `OB_SEND_TO_MARKET:${broker}`,
      payload: {
        book_id: bookId,
        broker,
        order_type: orderType,
        strategy: bookId,
        security_id: h.security_id,
        isin: sec?.isin ?? null,
        limitPrice: orderType === "limit" ? limitRands : null,
        // 2026-07-15: stamp the IRESS AccountCode on the BFF seed row so
        // the pre-trade limit guard can correlate the row back to the
        // desk account. Previously `oems_order_audit.client_account`
        // held the MINT user email on BFF seeds vs the IRESS account
        // code on worker poll rows — a `.eq("client_account", "56378")`
        // filter on inflight orders would miss every BFF seed, leaving
        // outstanding buys/sells out of the cash + naked-short math.
        // 2026-07-20: the typed `broker_account_code` column on the row
        // is the source of truth; this JSON mirror remains only for
        // backwards-compat with any consumer still reading the legacy
        // JSON path.
        broker_account_code: deskAccountCode,
        sent_by: auth.ctx.email,
        sent_at: new Date().toISOString(),
        holding_id: h.id,
        trader: auth.ctx.email,
        uat_test: uatTest,
        // 2026-07-14 — limit guard contract. Stamp on every audit row
        // so the desk UI can render "Guarded / Not guarded" + the
        // snapshot for forensic replay. When enforced=false the
        // skip_reason carries the gap so the operator never wonders
        // whether a naked short went out.
        limits_enforced: guard.enforced,
        limits_checked_at: limitsCheckedAt,
        limits_account_code: deskAccountCode,
        limits_skip_reason: guard.enforced ? null : guard.skipReason,
        limits_snapshot: guard.snapshot,
      },
      result_payload: {
        broker,
        venue: "JSE",
        tif: "DAY",
        arrivalMid: sec?.last_price != null ? Number(sec.last_price) / 100 : null,
        uat_test: uatTest,
      },
    };
  });

  const { data: inserted, error: insertErr } = await institutional
    .from("oems_order_audit")
    .insert(executionRows)
    .select("id, order_id");

  if (insertErr) {
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  // Optional rebalance_request_c mirror. Degrade softly if the table is missing.
  let rebalanceId: string | null = null;
  let rebalanceNotice: string | null = null;
  try {
    const proposedComposition = holdings.map((h) => {
      const sec = secMap[h.security_id];
      return {
        symbol: sec?.symbol ?? null,
        isin: sec?.isin ?? null,
        side: (h.trade_side ?? "buy").toLowerCase(),
        qty: Number(h.quantity) || 0,
        limit_cents: orderType === "limit" ? Math.round(Number(h.Expected_fill ?? 0)) : null,
      };
    });
    const { data: rbRow, error: rbErr } = await institutional
      .from("rebalance_request_c")
      .insert({
        strategy_id: bookId,
        requested_by: auth.ctx.email,
        current_composition: [],
        proposed_composition: proposedComposition,
        affected_investors: userIds,
        status: "ic_approved",
      })
      .select("id")
      .maybeSingle();

    if (rbErr) {
      if (isSupabaseSchemaMissing(rbErr)) {
        rebalanceNotice =
          "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql. Execution rows written to oems_order_audit only.";
      } else {
        rebalanceNotice = `rebalance_request_c insert failed: ${rbErr.message}`;
      }
    } else {
      rebalanceId = (rbRow?.id as string) ?? null;
    }
  } catch (e) {
    rebalanceNotice = `rebalance_request_c insert failed: ${(e as Error).message}`;
  }

  // ── UAT worker fanout ─────────────────────────────────────────────
  // Gated by: (a) `IRESS_UAT_MODE=true` on Vercel, (b) `IRESS_WORKER_URL`
  // set, and (c) the caller set `uat_test: true` in the body. When all
  // three are true the worker calls OrderCreate3 on MINT_CT for each
  // execution row and stamps the broker OrderNumber back onto the audit
  // table. When any gate is off we return `mode: "audit-only"` and the
  // desk falls back to the existing /fills POST (manual Excel upload).
  const uatFanout: {
    attempted: boolean;
    mode: "uat" | "production" | "audit-only";
    ok: boolean;
    sent: number;
    failed: number;
    notice: string | null;
  } = {
    attempted: false,
    mode: "audit-only",
    ok: true,
    sent: 0,
    failed: 0,
    notice: null,
  };

  /* LANE SELECTION.
     "uat"        -> worker POST /uat/send-to-market   (test book, CT semantics)
     "production" -> worker POST /orders/send-to-market (real client money)
     "audit-only" -> neither; rows are written and nothing is dispatched.

     Production requires IRESS_PRODUCTION_ORDERS=1 on Vercel AND the worker's own
     readiness gate to pass. The two are checked independently on purpose: Vercel
     decides whether to ATTEMPT dispatch, the worker decides whether it is safe to
     EXECUTE, and the worker's answer is the one that governs. A Vercel flag set
     ahead of the worker's cannot send an order — the worker returns 409 with the
     unmet conditions named.

     uat_test wins when both are set, so a UAT run can never be silently promoted
     to a real trade by a stray production flag. */
  const productionOrders = ["1", "true"].includes(
    (process.env.IRESS_PRODUCTION_ORDERS ?? "").trim().toLowerCase(),
  );

  /* A caller that ASKED for the UAT lane must never be promoted to production.
     `uatTest` is already false when IRESS_UAT_MODE is off, so testing `!uatTest`
     alone would have sent a `uat_test: true` request — from the UAT Test Runner,
     whose whole purpose is throwaway orders — straight to a real broker the
     moment production orders were enabled. Gate on the caller's INTENT
     (`body.uat_test`), not on the resolved lane. */
  const wantsUatLane = body.uat_test === true;
  if (wantsUatLane && !uatModeEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "uat_test=true but IRESS_UAT_MODE is off on Vercel. Refusing to run a UAT request against the production lane. Enable UAT mode, or drop uat_test to place a real order deliberately.",
      },
      { status: 409 },
    );
  }
  const productionSend = !wantsUatLane && productionOrders && !isUatEnv();
  const workerPath = uatTest ? "/uat/send-to-market" : "/orders/send-to-market";

  if ((uatTest || productionSend) && isIressWorkerConfigured()) {
    uatFanout.attempted = true;
    uatFanout.mode = uatTest ? "uat" : "production";
    const insertedRows = (inserted ?? []) as Array<{ id: string; order_id: string }>;
    const results: Array<{ id: string; ok: boolean; error?: string; iressOrderNumber?: string }> = [];
    // Sequential (not Promise.all) to avoid hammering the worker's single
    // IRESS license seat; UAT runs are small and clarity beats throughput.
    for (const row of insertedRows) {
      const res = await callWorker<WorkerUatResponse>({
        method: "POST",
        path: workerPath,
        // The production lane takes the account AND destination from the
        // worker's own env — never from this request. Passing broker_destination
        // on that lane would let the BFF route a client's trade to an arbitrary
        // book, so it is sent only on the UAT lane.
        body: uatTest
          ? { order_audit_id: row.id, broker_destination: broker }
          : { order_audit_id: row.id },
        timeoutMs: 15_000,
      });
      if (res.ok && res.body?.ok) {
        results.push({ id: row.id, ok: true, iressOrderNumber: res.body.iressOrderNumber });
        uatFanout.sent += 1;
      } else {
        const errMsg = res.ok
          ? (res.body?.errorDescription ?? res.body?.errorNumber?.toString() ?? "unknown worker error")
          : res.error;
        results.push({ id: row.id, ok: false, error: errMsg });
        uatFanout.failed += 1;
      }
    }
    uatFanout.ok = uatFanout.failed === 0;
    if (uatFanout.failed > 0) {
      const lane = uatTest ? "UAT" : "PRODUCTION";
      uatFanout.notice = `${uatFanout.failed} of ${insertedRows.length} ${lane} orders could not be sent to IRESS — audit rows are intact; see uat_results for per-row detail.`;
    }
    return NextResponse.json({
      ok: uatFanout.ok,
      execution_ids: insertedRows.map((r) => r.id),
      order_ids: insertedRows.map((r) => r.order_id),
      rebalance_id: rebalanceId,
      notice: rebalanceNotice,
      count: executionRows.length,
      mode: uatFanout.mode,
      uat: {
        attempted: uatFanout.attempted,
        sent: uatFanout.sent,
        failed: uatFanout.failed,
        notice: uatFanout.notice,
        results,
      },
      // 2026-07-14: surface the pre-trade limit guard result on every
      // successful dispatch. The audit row carries the same fields
      // (payload.limits_*) so the operator can replay the snapshot.
      limits: {
        enforced: guard.enforced,
        account_code: deskAccountCode,
        checked_at: limitsCheckedAt,
        skip_reason: guard.enforced ? null : guard.skipReason,
        snapshot: guard.snapshot,
      },
    });
  }

  if (uatTest && !isIressWorkerConfigured()) {
    // Caller asked for UAT but the worker URL is unset — keep audit rows
    // and surface a clear notice so the desk knows the live fanout didn't fire.
    uatFanout.notice =
      "uat_test=true but IRESS_WORKER_URL is not configured on Vercel — audit rows written in audit-only mode.";
  }

  return NextResponse.json({
    ok: true,
    execution_ids: (inserted ?? []).map((r) => r.id),
    order_ids: (inserted ?? []).map((r) => r.order_id),
    rebalance_id: rebalanceId,
    notice: rebalanceNotice,
    count: executionRows.length,
    mode: uatFanout.mode,
    uat: {
      attempted: uatFanout.attempted,
      sent: uatFanout.sent,
      failed: uatFanout.failed,
      notice: uatFanout.notice,
    },
    // 2026-07-14: limit guard surface on the audit-only path too.
    limits: {
      enforced: guard.enforced,
      account_code: deskAccountCode,
      checked_at: limitsCheckedAt,
      skip_reason: guard.enforced ? null : guard.skipReason,
      snapshot: guard.snapshot,
    },
  });
}
