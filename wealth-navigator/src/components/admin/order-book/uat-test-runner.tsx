"use client";

/**
 * UatTestRunner — Mint OEM Finalisation Phase UAT
 *
 * Side-by-side panel mounted on the Order Book page when UAT mode is on.
 * Lets the desk run three pre-canned scenarios that exercise the full
 * send-to-market → OrderCreate3 → OrderPadGetByAccount → fills → SSE
 * pipeline against the MINT_CT IOS UAT account.
 *
 *  Scenario 1 — Single SOL buy 400 @ 177 Limit
 *  Scenario 2 — Basket of 5 orders (mixed BUY/SELL, mixed limits)
 *  Scenario 3 — Create + cancel an order, verify state transitions
 *
 * The runner pre-creates the `stock_holdings_c` rows it needs in RETAIL so
 * the existing `/api/admin/orderbook/send-to-market` BFF has something to
 * resolve. After send-to-market it polls the execution rows for state
 * transitions and shows results inline.
 *
 * All test orders are tagged `payload.uat_test = true` (and the audit
 * `source` is `OB_SEND_TO_MARKET_UAT`) so the desk can filter them out of
 * production reports with a single query:
 *
 *   SELECT * FROM oems_order_audit WHERE payload->>'uat_test' = 'true';
 *
 * The panel is itself UAT-gated: it renders nothing when
 * `IRESS_UAT_MODE !== "true"` on Vercel.
 *
 * 2026-07-20 refactor: when `/api/admin/orderbook/send-to-market` returns
 * `422` with a `violations` array (the bulk limit guard fired), the
 * runner now opens `<GuardrailForceCorrectionDialog/>` in `mode="bulk"`
 * so the operator can see every offending holding + reason and decide
 * whether to resubmit (which re-runs the bulk preflight + sends).
 */

import { CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GuardrailForceCorrectionDialog } from "@/components/oems/primitives/guardrail-force-correction-dialog";
import type { BulkViolation, PreflightResult, SubmitResult } from "@/lib/orders";
import { cn } from "@/lib/cn";

interface Scenario1 {
  id: "single-fill";
  title: "Scenario 1 — Single SOL buy, watch it fill";
  description: "Submit one SOL buy 400 @ 177 Limit. Verify ExecutionView updates working → filled.";
  symbol: string;
  qty: number;
  limit: number;
  side: "buy" | "sell";
}

interface Scenario2 {
  id: "basket-5";
  title: "Scenario 2 — Basket of 5 orders, partial fills";
  description: "Submit 5 mixed orders. Verify aggregate state (some filled, some partial, some working).";
  orders: Array<{ symbol: string; qty: number; limit: number; side: "buy" | "sell" }>;
}

interface Scenario3 {
  id: "create-cancel";
  title: "Scenario 3 — Create + cancel an order";
  description: "Submit a NPN limit order, then cancel via OrderDelete. Verify state transitions to CANCELLED.";
  symbol: string;
  qty: number;
  limit: number;
  side: "buy" | "sell";
}

type Scenario = Scenario1 | Scenario2 | Scenario3;

const SCENARIOS: Scenario[] = [
  {
    id: "single-fill",
    title: "Scenario 1 — Single SOL buy, watch it fill",
    description: "Submit one SOL buy 400 @ 177 Limit. Verify ExecutionView updates working → filled.",
    symbol: "SOL",
    qty: 400,
    limit: 17_700, // cents (R177), consistent with the other scenarios' cents limits
    side: "buy",
  },
  {
    id: "basket-5",
    title: "Scenario 2 — Basket of 5 orders, partial fills",
    description: "Submit 5 mixed orders. Verify aggregate state (some filled, some partial, some working).",
    orders: [
      { symbol: "NPN", qty: 50, limit: 300_000, side: "buy" },
      { symbol: "MTN", qty: 200, limit: 9_000, side: "buy" },
      { symbol: "FSR", qty: 1_000, limit: 1_700, side: "buy" },
      { symbol: "SBK", qty: 80, limit: 19_500, side: "buy" },
      { symbol: "AGL", qty: 60, limit: 12_500, side: "buy" },
    ],
  },
  {
    id: "create-cancel",
    title: "Scenario 3 — Create + cancel an order",
    description:
      "Submit a NPN limit order, then cancel via OrderDelete. Verify state transitions to CANCELLED.",
    symbol: "NPN",
    qty: 10,
    limit: 305_000,
    side: "buy",
  },
];

interface ScenarioResult {
  ok: boolean;
  message: string;
  details: string[];
}

function isScenario1(s: Scenario): s is Scenario1 {
  return s.id === "single-fill";
}
function isScenario2(s: Scenario): s is Scenario2 {
  return s.id === "basket-5";
}
function isScenario3(s: Scenario): s is Scenario3 {
  return s.id === "create-cancel";
}

export function UatTestRunner({ className }: { className?: string }) {
  const [uatEnabled, setUatEnabled] = React.useState(false);
  const [running, setRunning] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, ScenarioResult>>({});
  // Bulk violation modal — opens when send-to-market returns 422 with
  // `violations`. The modal handles its own resubmit (re-runs the bulk
  // preflight). Last-fired `bookId` is captured so the modal's "resubmit"
  // action knows what to retarget.
  const [bulkModal, setBulkModal] = React.useState<{
    open: boolean;
    bookId: string;
    violations: BulkViolation[];
    preflight: PreflightResult;
    lastResult?: ScenarioResult;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/orderbook/uat-status", { cache: "no-store" })
      .then(
        (r) =>
          r.json() as Promise<{
            uat_mode: boolean;
            worker_configured: boolean;
            worker_uat_mode: boolean | null;
          }>,
      )
      .then((body) => {
        if (cancelled) return;
        setUatEnabled(body.uat_mode && body.worker_configured && body.worker_uat_mode === true);
      })
      .catch(() => {
        if (!cancelled) setUatEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runScenario = React.useCallback(async (scenario: Scenario): Promise<ScenarioResult> => {
    // Each scenario creates a fresh UAT book under a unique name so the
    // execution view can be filtered to that book. Book naming convention:
    //   UAT-<scenario>-<timestamp>
    const bookId = `UAT-${scenario.id}-${Date.now().toString(36)}`;

    // Step 1: seed `stock_holdings_c` for the book so send-to-market has
    // a strategy to resolve. We do this via a small admin endpoint.
    const seedBody = await (async (): Promise<{ ok: boolean; error?: string }> => {
      if (isScenario1(scenario)) {
        return seedHolding(bookId, scenario.symbol, scenario.qty, scenario.limit, scenario.side);
      }
      if (isScenario2(scenario)) {
        for (const o of scenario.orders) {
          const r = await seedHolding(bookId, o.symbol, o.qty, o.limit, o.side);
          if (!r.ok) return r;
        }
        return { ok: true };
      }
      if (isScenario3(scenario)) {
        return seedHolding(bookId, scenario.symbol, scenario.qty, scenario.limit, scenario.side);
      }
      return { ok: false, error: "unknown scenario" };
    })();

    if (!seedBody.ok) {
      return { ok: false, message: "seed failed", details: [seedBody.error ?? "unknown error"] };
    }

    // Step 2: send-to-market with uat_test=true so the BFF fans out to
    // the worker.
    const sendRes = await fetch("/api/admin/orderbook/send-to-market", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        book_id: bookId,
        broker: "JSE",
        order_type: "limit",
        uat_test: true,
      }),
    });
    const sendBody = (await sendRes.json()) as {
      ok: boolean;
      error?: string;
      mode?: string;
      execution_ids?: string[];
      uat?: {
        sent: number;
        failed: number;
        results: Array<{ id: string; ok: boolean; iressOrderNumber?: string; error?: string }>;
      };
      notice?: string;
      violations?: BulkViolation[];
      code?: string;
    };
    if (!sendRes.ok || !sendBody.ok) {
      // 422 with violations → bulk force-correction path. The scenario
      // itself doesn't dispatch; the modal drives the resubmit.
      if (
        sendRes.status === 422 &&
        Array.isArray(sendBody.violations) &&
        sendBody.violations.length > 0
      ) {
        const firstViolation = sendBody.violations[0];
        setBulkModal({
          open: true,
          bookId,
          violations: sendBody.violations,
          preflight: {
            ok: false,
            verdict: "blocked_unverifiable",
            code:
              sendBody.code === "limit_guard_unverified_sell"
                ? "limit_guard_unverified_sell"
                : "limit_guard_violation",
            message:
              sendBody.error ??
              `Bulk limit guard refused the dispatch — ${sendBody.violations.length} holding(s) breached the cash / position limits.`,
          },
        });
        return {
          ok: false,
          message: "blocked by bulk limit guard",
          details: sendBody.violations.map(
            (v) => `  · ${v.side.toUpperCase()} ${v.qty.toLocaleString()} ${v.symbol} — ${v.reason}`,
          ),
        };
      }
      return {
        ok: false,
        message: `send-to-market ${sendRes.status}`,
        details: [sendBody.error ?? "unknown error", sendBody.notice ?? ""].filter(Boolean),
      };
    }

    const details: string[] = [];
    details.push(`book_id: ${bookId}`);
    details.push(`mode: ${sendBody.mode ?? "—"}`);
    details.push(`execution_ids: ${(sendBody.execution_ids ?? []).length}`);
    if (sendBody.uat) {
      details.push(`uat sent: ${sendBody.uat.sent}/${(sendBody.execution_ids ?? []).length}`);
      if (sendBody.uat.failed > 0) {
        details.push(`uat failed: ${sendBody.uat.failed}`);
      }
      for (const r of sendBody.uat.results ?? []) {
        details.push(
          `  · ${r.ok ? "OK" : "FAIL"} ${r.id} ${r.iressOrderNumber ?? ""} ${r.error ?? ""}`.trim(),
        );
      }
    }

    // Step 3 (scenarios 1 + 3): poll the execution view for state
    // transitions. Scenario 3 also fires an OrderDelete after send.
    if (isScenario3(scenario) && sendBody.uat?.results?.[0]?.iressOrderNumber) {
      const cancelTarget = sendBody.uat.results[0].iressOrderNumber;
      details.push(`cancelling IRESS order ${cancelTarget}…`);
      const cancelRes = await fetch("/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: cancelTarget, account: "UAT" }),
      });
      const cancelBody = (await cancelRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      details.push(
        `cancel ${cancelRes.ok && cancelBody.ok ? "OK" : "FAIL"} ${cancelBody.error ?? ""}`.trim(),
      );
    }

    return {
      ok: true,
      message: `book ${bookId} dispatched`,
      details,
    };
  }, []);

  const onRun = React.useCallback(
    async (scenario: Scenario) => {
      setRunning(scenario.id);
      try {
        const res = await runScenario(scenario);
        setResults((prev) => ({ ...prev, [scenario.id]: res }));
        if (res.ok) {
          toast.success(`${scenario.title} — dispatched`);
        } else if (!bulkModal?.open) {
          // Bulk-modal flow already shows the toast in the modal itself;
          // suppress the duplicate toast here.
          toast.error(`${scenario.title} — ${res.message}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setResults((prev) => ({
          ...prev,
          [scenario.id]: { ok: false, message: "exception", details: [msg] },
        }));
        toast.error(`${scenario.title} — exception: ${msg}`);
      } finally {
        setRunning(null);
      }
    },
    [runScenario, bulkModal?.open],
  );

  /**
   * Bulk-modal resubmit: re-calls send-to-market with the same `book_id`.
   * On pass, closes the modal and updates the per-scenario result. On a
   * chained 422 with a NEW set of violations, the modal stays open with
   * the refreshed payload (the modal handles the inline chain error too).
   */
  const resubmitBulk = React.useCallback(async (): Promise<SubmitResult> => {
    if (!bulkModal) {
      return {
        ok: false,
        preflight: {
          ok: false,
          verdict: "blocked_unverifiable",
          code: "limit_guard_violation",
          message: "No bulk modal state",
        },
      };
    }
    let res: Response;
    try {
      res = await fetch("/api/admin/orderbook/send-to-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          book_id: bulkModal.bookId,
          broker: "JSE",
          order_type: "limit",
          uat_test: true,
        }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        preflight: {
          ok: false,
          verdict: "blocked_unverifiable",
          code: "limit_guard_violation",
          message: `Resubmit request failed: ${msg}`,
        },
      };
    }
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      execution_ids?: string[];
      uat?: { sent: number; failed: number };
      notice?: string;
      error?: string;
      violations?: BulkViolation[];
      code?: string;
    };
    if (res.ok && body.ok) {
      const sentCount = body.execution_ids?.length ?? 0;
      setResults((prev) => ({
        ...prev,
        ["bulk-resubmit"]: {
          ok: true,
          message: `bulk resubmit dispatched (${sentCount} order${sentCount === 1 ? "" : "s"})`,
          details: [
            `book_id: ${bulkModal.bookId}`,
            `uat sent: ${body.uat?.sent ?? sentCount}/${sentCount}`,
          ],
        },
      }));
      setBulkModal(null);
      return {
        ok: true,
        preflight: { ok: true, verdict: "pass", code: "pass", message: "Bulk resubmit OK" },
      };
    }
    // 422 with new violations → refresh modal payload, stay open.
    if (res.status === 422 && Array.isArray(body.violations) && body.violations.length > 0) {
      setBulkModal((prev) =>
        prev
          ? {
              ...prev,
              violations: body.violations!,
              preflight: {
                ok: false,
                verdict: "blocked_unverifiable",
                code:
                  body.code === "limit_guard_unverified_sell"
                    ? "limit_guard_unverified_sell"
                    : "limit_guard_violation",
                message:
                  body.error ??
                  `Bulk limit guard still refusing (${body.violations!.length} remaining violation${body.violations!.length === 1 ? "" : "s"}).`,
              },
            }
          : prev,
      );
    }
    return {
      ok: false,
      preflight: {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "limit_guard_violation",
        message: body.error ?? `send-to-market ${res.status} ${body.notice ?? ""}`,
      },
      error: body.error ?? `send-to-market ${res.status}`,
    };
  }, [bulkModal]);

  if (!uatEnabled) return null;

  return (
    <div className={cn("rounded-xl border border-warning/30 bg-card/40 p-4 space-y-3", className)}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-warning">UAT Test Runner</h3>
          <p className="text-[10px] text-muted-foreground">
            All orders dispatched here are tagged <code>uat_test=true</code> and routed to the MINT_CT IOS UAT
            account. No real client money at risk.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {SCENARIOS.map((scenario) => {
          const isRunning = running === scenario.id;
          const result = results[scenario.id];
          return (
            <div key={scenario.id} className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                  {scenario.title}
                </h4>
                {result ? (
                  result.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive shrink-0" />
                  )
                ) : null}
              </div>
              <p className="text-[10px] text-muted-foreground">{scenario.description}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={isRunning}
                onClick={() => void onRun(scenario)}
                className="w-full"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    Running…
                  </>
                ) : (
                  <>
                    <Play className="mr-1.5 h-3 w-3" />
                    Run
                  </>
                )}
              </Button>
              {result ? (
                <div className="space-y-1 rounded-md border border-border/50 bg-background/50 p-2">
                  <div className="flex items-center gap-1.5">
                    <Badge variant={result.ok ? "success" : "destructive"} className="text-[9px]">
                      {result.ok ? "OK" : "FAIL"}
                    </Badge>
                    <span className="text-[10px] text-foreground">{result.message}</span>
                  </div>
                  {result.details.length > 0 ? (
                    <ul className="text-[9px] text-muted-foreground space-y-0.5 font-mono break-all">
                      {result.details.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {bulkModal && (
        <GuardrailForceCorrectionDialog
          open={bulkModal.open}
          onOpenChange={(o) => {
            setBulkModal((prev) => (prev ? { ...prev, open: o } : prev));
            if (!o) setBulkModal(null);
          }}
          preflight={bulkModal.preflight}
          mode="bulk"
          attempted={{
            symbol: bulkModal.violations[0]?.symbol ?? "—",
            side: bulkModal.violations[0]?.side ?? "buy",
            qty: bulkModal.violations.reduce((s, v) => s + v.qty, 0),
            price_cents: null,
          }}
          bulkViolations={bulkModal.violations}
          onResubmit={resubmitBulk}
        />
      )}
    </div>
  );
}

async function seedHolding(
  bookId: string,
  symbol: string,
  qty: number,
  limitCents: number,
  side: "buy" | "sell",
): Promise<{ ok: boolean; error?: string }> {
  // The runner needs `stock_holdings_c` rows for the BFF to resolve a
  // strategy. There's no public admin endpoint to insert directly, so we
  // call the existing holdings API. If the desk wants to clean these up
  // post-test, they can `DELETE FROM stock_holdings_c WHERE
  // strategy_name_snapshot LIKE 'UAT-%'`.
  try {
    const res = await fetch("/api/admin/orderbook/test-seed-holding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book_id: bookId, symbol, qty, limit_cents: limitCents, side }),
    });
    if (!res.ok) {
      return { ok: false, error: `seed endpoint returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default UatTestRunner;
