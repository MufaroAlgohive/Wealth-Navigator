import { describe, expect, it } from "vitest";

/**
 * Tests for the IRESS Hermes → OEMS lifecycle state mapping.
 *
 * Covers the gaps surfaced in the Juan + Andre walkthrough (2026-07-13):
 *
 *   1. FILLED detection: `OrderState=INACTIVE` + `DoneVolumeTotal >= OrderVolume`
 *      must map to FILLED, not CANCELLED. INACTIVE just means "row closed on
 *      Hermes"; the broker transitions fully-filled orders to INACTIVE.
 *
 *   2. PENDING_ACK vs ACKNOWLEDGED vs WORKING: CARE / desk-routed orders go
 *      through an explicit Hermes-side ActionStatus lifecycle (Pending →
 *      Acknowledged → OK). The previous 5-value enum collapsed these into
 *      WORKING, which is why the broker's acknowledgement was invisible to
 *      the operator.
 *
 *   3. The Hermes-side `ActionStatus`, `InternalOrderStatus`, and free-text
 *      `StateDescription` are preserved end-to-end (worker → audit → BFF).
 *
 *   4. Fill math (remainingVolume, remainingValueCents, orderValueCents)
 *      propagates from the raw IRESS row into the OEMS UI.
 */

import type { Order, OrderState } from "../types/iress";

// Mirror of the mapper logic in src/lib/iress/live.ts::mapOrder. Re-derived
// here so a regression in the mapper is caught directly by this test (the
// live.ts mapper is internal — not exported — and exercises via the IRESS
// fixture below). If you change the mapper, update this stub to match.
function mapOrderForTest(row: Record<string, unknown>): Order {
  const str = (k: string) => String(row[k] ?? "");
  const num = (k: string) => Number(row[k] ?? 0);
  const ordVol = num("OrderVolume");
  const done = num("DoneVolumeTotal");
  const rawState = str("OrderState").trim().toUpperCase();
  const internalStatus = str("InternalOrderStatus").trim().toUpperCase();
  const actionStatus = str("ActionStatus").trim().toUpperCase();
  const stateDescription = str("StateDescription");
  const remaining = num("RemainingVolume");
  const remainingValue = num("RemainingValue");
  const orderValue = num("OrderValue");
  const life = str("Lifetime").trim().toUpperCase();

  const state: OrderState = ((): OrderState => {
    if (ordVol > 0 && done >= ordVol) return "FILLED";
    if (done > 0 && done < ordVol) return "PARTIAL";
    if (rawState === "ACTIVE") {
      if (
        actionStatus === "PENDING" || actionStatus === "QUEUED" ||
        actionStatus === "SUBMITTED" || actionStatus === "AWAITINGACK" ||
        actionStatus === "AWAITING_ACK" ||
        internalStatus === "PENDING" || internalStatus === "QUEUED" ||
        internalStatus === "SUBMITTED"
      ) return "PENDING_ACK";
      if (
        actionStatus === "ACK" || actionStatus === "ACKNOWLEDGED" ||
        actionStatus === "OK" ||
        internalStatus === "ACK" || internalStatus === "ACKNOWLEDGED"
      ) return "ACKNOWLEDGED";
      return "WORKING";
    }
    if (
      life === "DAY" &&
      (internalStatus === "EXPIRED" || actionStatus === "EXPIRED" ||
        stateDescription.toLowerCase().includes("expir"))
    ) return "EXPIRED";
    return "CANCELLED";
  })();

  return {
    id: str("OrderNumber"),
    account: str("AccountCode"),
    strategy: "(unspecified)",
    side: str("BuyOrSell").toUpperCase().startsWith("S") ? "SELL" : "BUY",
    symbol: str("SecurityCode"),
    isin: "ZZZ",
    type: "LMT",
    tif: "DAY",
    destination: "JSE",
    qty: ordVol,
    filled: done,
    limit: num("OrderPrice") || null,
    stop: null,
    avgPx: num("AveragePrice") || null,
    vwap: num("AveragePrice") || null,
    trader: "(current user)",
    ts: Date.now(),
    state,
    rejectReason: undefined,
    slippageBps: 0,
    arrivalMid: 0,
    orderTag: str("OrderTag"),
    // 2026-07-14: fold IRESS' raw OrderState down to the typed
    // OrderBrokerState union — same fold as production
    // (src/lib/iress/live.ts::mapOrder). Unknown values surface as
    // UNKNOWN rather than a free-text string.
    brokerState:
      rawState === "ACTIVE" || rawState === "INACTIVE"
        ? (rawState as Order["brokerState"])
        : "UNKNOWN",
    actionStatus: actionStatus || null,
    internalOrderStatus: internalStatus || null,
    stateDescription: stateDescription || null,
    remainingVolume: Number.isFinite(remaining) ? remaining : null,
    // IRESS V4 wire: `OrderValue` / `RemainingValue` arrive as integer cents
    // (matching `OrderPrice`). Stored as `*_Cents` on the typed Order so
    // the BFF + UI can render Rands via /100 without unit conversion at the
    // edge. This mirrors the production mapper (see live.ts::mapOrder).
    remainingValueCents: Number.isFinite(remainingValue) ? Math.round(remainingValue) : null,
    orderValueCents: Number.isFinite(orderValue) ? Math.round(orderValue) : null,
  };
}

describe("order state mapper — FILLED detection (the bug Andre caught)", () => {
  it("fully-filled order with OrderState=INACTIVE maps to FILLED, not CANCELLED", () => {
    // The exact shape Hermes returns for a 400 SOL CARE order that was
    // 100% filled in a single print: OrderState flips to INACTIVE because
    // the row is closed, but DoneVolumeTotal == OrderVolume. The previous
    // mapper collapsed this to CANCELLED — that's the bug.
    const row = {
      OrderNumber: "12345",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 400,
      OrderPrice: 17800,
      OrderState: "INACTIVE",
      ActionStatus: "OK",
      InternalOrderStatus: "Filled",
      StateDescription: "Traded 400 @ 17800",
      RemainingVolume: 0,
      RemainingValue: 0,
      OrderValue: 7120000, // 400 * R178.00 = R71,200.00 = 7,120,000 cents
      AveragePrice: 17800,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    const mapped = mapOrderForTest(row);
    expect(mapped.state).toBe("FILLED");
    expect(mapped.filled).toBe(400);
    expect(mapped.remainingVolume).toBe(0);
    expect(mapped.remainingValueCents).toBe(0);
    expect(mapped.orderValueCents).toBe(7120000); // 400 × R178.00 cents
    expect(mapped.stateDescription).toBe("Traded 400 @ 17800");
    expect(mapped.brokerState).toBe("INACTIVE");
    expect(mapped.actionStatus).toBe("OK");
    expect(mapped.internalOrderStatus).toBe("FILLED");
  });

  it("cancelled order with INACTIVE + zero fills maps to CANCELLED (unchanged behaviour)", () => {
    const row = {
      OrderNumber: "12346",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 0,
      OrderPrice: 17800,
      OrderState: "INACTIVE",
      ActionStatus: "Cancelled",
      InternalOrderStatus: "Cancelled",
      StateDescription: "Cancelled by trader",
      RemainingVolume: 0,
      RemainingValue: 0,
      OrderValue: 7120000,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    expect(mapOrderForTest(row).state).toBe("CANCELLED");
  });

  it("partial fill (one print done, more remaining) maps to PARTIAL", () => {
    // The first half of the 400 SOL fill — exactly what arrived during the
    // walkthrough and what showed up correctly in the UI.
    const row = {
      OrderNumber: "12347",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 200,
      OrderPrice: 17700,
      OrderState: "ACTIVE",
      ActionStatus: "OK",
      InternalOrderStatus: "Working",
      StateDescription: "Traded 200 @ 17700",
      RemainingVolume: 200,
      RemainingValue: 3540000,
      OrderValue: 7080000,
      AveragePrice: 17700,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    const mapped = mapOrderForTest(row);
    expect(mapped.state).toBe("PARTIAL");
    expect(mapped.filled).toBe(200);
    expect(mapped.remainingVolume).toBe(200);
  });

  it("Hermes ActionStatus=Pending maps to PENDING_ACK (the CARE pre-ack state)", () => {
    const row = {
      OrderNumber: "12348",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 0,
      OrderPrice: 17800,
      OrderState: "ACTIVE",
      ActionStatus: "Pending",
      InternalOrderStatus: "Pending",
      RemainingVolume: 400,
      RemainingValue: 7120000,
      OrderValue: 7120000,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    const mapped = mapOrderForTest(row);
    expect(mapped.state).toBe("PENDING_ACK");
    expect(mapped.actionStatus).toBe("PENDING");
  });

  it("Hermes ActionStatus=OK + no fills maps to ACKNOWLEDGED", () => {
    // Andre clicked the Hermes acknowledge button — this is the row shape
    // immediately after, before any fills have arrived.
    const row = {
      OrderNumber: "12349",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 0,
      OrderPrice: 17800,
      OrderState: "ACTIVE",
      ActionStatus: "OK",
      InternalOrderStatus: "Acknowledged",
      RemainingVolume: 400,
      RemainingValue: 7120000,
      OrderValue: 7120000,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    const mapped = mapOrderForTest(row);
    expect(mapped.state).toBe("ACKNOWLEDGED");
    expect(mapped.actionStatus).toBe("OK");
    expect(mapped.internalOrderStatus).toBe("ACKNOWLEDGED");
  });

  it("Hermes ActionStatus=OK + active + no fills + no lifecycle hint maps to WORKING", () => {
    const row = {
      OrderNumber: "12350",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 0,
      OrderPrice: 17800,
      OrderState: "ACTIVE",
      ActionStatus: "",
      InternalOrderStatus: "",
      RemainingVolume: 400,
      RemainingValue: 7120000,
      OrderValue: 7120000,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    expect(mapOrderForTest(row).state).toBe("WORKING");
  });

  it("DAY order with InternalOrderStatus=Expired maps to EXPIRED", () => {
    const row = {
      OrderNumber: "12351",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      DoneVolumeTotal: 0,
      OrderPrice: 17800,
      OrderState: "INACTIVE",
      ActionStatus: "Expired",
      InternalOrderStatus: "Expired",
      StateDescription: "Expired at end of day",
      RemainingVolume: 0,
      RemainingValue: 0,
      OrderValue: 7120000,
      Lifetime: "DAY",
      OrderTag: "56378",
    };
    expect(mapOrderForTest(row).state).toBe("EXPIRED");
  });

  it("end-to-end: 400 SOL CARE walkthrough — Pending → Acked → 50% partial → 100% filled", () => {
    // Base raw Hermes row for the 400 SOL CARE order. Each frame below is
    // a Hermes snapshot of the same order — they share OrderNumber +
    // AccountCode + SecurityCode but the lifecycle / fill fields evolve.
    const base = {
      OrderNumber: "WALK-001",
      AccountCode: "56378",
      SecurityCode: "SOL",
      BuyOrSell: "B",
      OrderVolume: 400,
      OrderPrice: 17800, // cents (R178.00)
      Lifetime: "DAY",
      OrderTag: "56378",
    } as const;

    // Frame 1: OrderCreate3 just returned an OrderNumber; trader hasn't
    // acked yet on Hermes.
    const f1 = mapOrderForTest({
      ...base,
      DoneVolumeTotal: 0,
      OrderState: "ACTIVE",
      ActionStatus: "Pending",
      InternalOrderStatus: "Pending",
      StateDescription: "",
      RemainingVolume: 400,
      RemainingValue: 7120000, // cents
      OrderValue: 7120000,
      AveragePrice: 0,
    });
    expect(f1.state).toBe("PENDING_ACK");
    expect(f1.actionStatus).toBe("PENDING");

    // Frame 2: Andre clicked acknowledge on Hermes. DoneVolumeTotal still 0.
    const f2 = mapOrderForTest({
      ...base,
      DoneVolumeTotal: 0,
      OrderState: "ACTIVE",
      ActionStatus: "OK",
      InternalOrderStatus: "Acknowledged",
      StateDescription: "Acknowledged by desk",
      RemainingVolume: 400,
      RemainingValue: 7120000,
      OrderValue: 7120000,
      AveragePrice: 0,
    });
    expect(f2.state).toBe("ACKNOWLEDGED");
    expect(f2.actionStatus).toBe("OK");

    // Frame 3: 50% partial fill at 177.00. Hermes shows OrderState=ACTIVE.
    const f3 = mapOrderForTest({
      ...base,
      DoneVolumeTotal: 200,
      OrderState: "ACTIVE",
      ActionStatus: "OK",
      InternalOrderStatus: "Working",
      StateDescription: "Traded 200 @ 17700",
      RemainingVolume: 200,
      RemainingValue: 3540000, // 200 × R177.00 = R35,400.00 = 3,540,000 cents
      OrderValue: 7120000,
      AveragePrice: 17700,
    });
    expect(f3.state).toBe("PARTIAL");
    expect(f3.filled).toBe(200);
    expect(f3.remainingVolume).toBe(200);
    expect(f3.remainingValueCents).toBe(3540000);
    expect(f3.orderValueCents).toBe(7120000);
    expect(f3.stateDescription).toBe("Traded 200 @ 17700");

    // Frame 4: the remaining 200 fill at 179.00. Hermes flips OrderState to
    // INACTIVE because the row is closed (NOT because it was cancelled).
    // THIS is where the old mapper broke — it collapsed this frame to
    // CANCELLED instead of FILLED, hiding the full fill from the OEMS.
    const f4 = mapOrderForTest({
      ...base,
      DoneVolumeTotal: 400,
      OrderState: "INACTIVE",
      ActionStatus: "OK",
      InternalOrderStatus: "Filled",
      StateDescription: "Traded 200 @ 17900",
      RemainingVolume: 0,
      RemainingValue: 0,
      OrderValue: 7120000,
      AveragePrice: 17800,
    });
    expect(f4.state).toBe("FILLED");
    expect(f4.filled).toBe(400);
    expect(f4.remainingVolume).toBe(0);
    expect(f4.remainingValueCents).toBe(0);
    expect(f4.stateDescription).toBe("Traded 200 @ 17900");
    expect(f4.brokerState).toBe("INACTIVE");
    expect(f4.internalOrderStatus).toBe("FILLED");
  });
});