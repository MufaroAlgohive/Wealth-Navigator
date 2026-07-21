import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * `<GuardrailForceCorrectionDialog/>` — the shared force-correction modal.
 *
 * 2026-07-20 coverage:
 *   - Renders the worker message verbatim ("You tried to SELL 150…")
 *   - Renders the glanceable summary line on top of the form
 *   - The "Clamp to N" affordance is offered only when there's an
 *     available-to-sell number (i.e. the source is IPS/derived) so the
 *     trader can rewrite qty to the safe max in one click
 *   - In `mode="bulk"` the violation table renders one row per violation
 */

import * as React from "react";

import { GuardrailForceCorrectionDialog } from "../components/oems/primitives/guardrail-force-correction-dialog";

const nakedShortPreflight = {
  ok: false,
  verdict: "blocked_naked_short" as const,
  code: "naked_short_blocked" as const,
  message:
    "Sell blocked: 150 SOL exceeds available-to-sell 100 on account 56378 — held 100, 0 in open sells (IPS settled position 100). We only sell stock we own.",
  sell: { held: 100, inflight_sells: 0, available: 100, source: "ips", note: "IPS settled position 100" },
};

const insufficientCashPreflight = {
  ok: false,
  verdict: "blocked_insufficient_cash" as const,
  code: "insufficient_cash" as const,
  message:
    "Buy blocked: SOL value R5000.00 exceeds available cash R3000.00 on account 56378 — desk cash R3000.",
  cash: { cash: 3000, inflight_buys: 0, available: 3000, source: "ips", note: "desk cash R3000" },
};

describe("<GuardrailForceCorrectionDialog/> — single mode", () => {
  it("renders the worker's verbatim message and a glanceable summary line", () => {
    const { getByText } = render(
      <GuardrailForceCorrectionDialog
        open
        onOpenChange={() => {}}
        preflight={nakedShortPreflight}
        mode="single"
        attempted={{ symbol: "SOL", side: "sell", qty: 150, price_cents: 17_700 }}
        onResubmit={async () => ({
          ok: true,
          preflight: { ok: true, verdict: "pass", code: "pass", message: "ok" },
        })}
      />,
    );
    expect(getByText(/Sell blocked: 150 SOL exceeds available-to-sell 100/)).toBeInTheDocument();
    expect(getByText(/You tried to SELL 150 SOL, but you only hold 100/)).toBeInTheDocument();
  });

  it("offers the 'Clamp to N' button only when available > 0", () => {
    const { getByText, rerender, queryByText } = render(
      <GuardrailForceCorrectionDialog
        open
        onOpenChange={() => {}}
        preflight={nakedShortPreflight}
        mode="single"
        attempted={{ symbol: "SOL", side: "sell", qty: 150, price_cents: 17_700 }}
        onResubmit={async () => ({
          ok: true,
          preflight: { ok: true, verdict: "pass", code: "pass", message: "ok" },
        })}
      />,
    );
    expect(getByText("Clamp to 100")).toBeInTheDocument();
    rerender(
      <GuardrailForceCorrectionDialog
        open
        onOpenChange={() => {}}
        preflight={{
          ...nakedShortPreflight,
          sell: { held: 0, inflight_sells: 0, available: 0, source: "none", note: "no position" },
        }}
        mode="single"
        attempted={{ symbol: "ZZZ", side: "sell", qty: 999_999, price_cents: null }}
        onResubmit={async () => ({
          ok: true,
          preflight: { ok: true, verdict: "pass", code: "pass", message: "ok" },
        })}
      />,
    );
    expect(queryByText(/Clamp to/)).not.toBeInTheDocument();
  });

  it("renders the insufficient-cash verdict + summary", () => {
    const { getByText } = render(
      <GuardrailForceCorrectionDialog
        open
        onOpenChange={() => {}}
        preflight={insufficientCashPreflight}
        mode="single"
        attempted={{ symbol: "SOL", side: "buy", qty: 100, price_cents: 50_00 }}
        onResubmit={async () => ({
          ok: true,
          preflight: { ok: true, verdict: "pass", code: "pass", message: "ok" },
        })}
      />,
    );
    expect(getByText(/Buy blocked: SOL value R5000\.00/)).toBeInTheDocument();
    expect(getByText(/You tried to BUY/)).toBeInTheDocument();
  });
});

describe("<GuardrailForceCorrectionDialog/> — bulk mode", () => {
  it("renders one row per violation", () => {
    const { getAllByText } = render(
      <GuardrailForceCorrectionDialog
        open
        onOpenChange={() => {}}
        preflight={{
          ok: false,
          verdict: "blocked_unverifiable",
          code: "limit_guard_violation",
          message: "Bulk limit guard refused the dispatch.",
        }}
        mode="bulk"
        attempted={{ symbol: "SOL", side: "sell", qty: 150, price_cents: 17_700 }}
        bulkViolations={[
          {
            holding_id: "h1",
            symbol: "SOL",
            side: "sell",
            qty: 100,
            reason: "exceeds available-to-sell 50",
            detail: { held: 50, inflight: 0, available: 50 },
          },
          {
            holding_id: "h2",
            symbol: "MTN",
            side: "buy",
            qty: 200,
            reason: "exceeds available cash R100",
            detail: { cash: 100, inflight: 0, available: 100 },
          },
        ]}
        onResubmit={async () => ({
          ok: true,
          preflight: { ok: true, verdict: "pass", code: "pass", message: "ok" },
        })}
      />,
    );
    expect(getAllByText("SOL").length).toBeGreaterThan(0);
    expect(getAllByText("MTN").length).toBeGreaterThan(0);
    expect(getAllByText(/100/).length).toBeGreaterThan(0);
    expect(getAllByText(/200/).length).toBeGreaterThan(0);
  });
});
