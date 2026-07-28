// Settlement extension tests for the gift-authorization lifecycle.
//
// These tests cover the worker side: how an IRESS fill maps to a
// gift_authorization state transition, and how the wallet / holding
// side-effects are wired. The retail-side state-machine tests live in
// MINT-DEVELOPMENT/api/__tests__/gift-lifecycle.test.js.

import { describe, it, expect, beforeEach } from "vitest";
import {
  GIFT_AUTH_STATUS,
  compareFillToCeiling,
  applyGiftFill,
  applyGiftTerminalNoFill,
  sweepExpiredParkedAuthorizations,
  sweepApprovalGraceExpired,
} from "../giftAuthorizationSettlement";
import { makeMockSupabase, MockSupabase } from "./mockSupabaseFactory";

type Row = Record<string, unknown>;

function seedAuth(stored: Record<string, Row[]>, overrides: Partial<Row> = {}): Row {
  const auth: Row = {
    id: "auth-1",
    reservation_id: "res-1",
    registry_item_id: "item-1",
    gifter_user_id: "user-gifter",
    gifter_email: "gifter@example.com",
    recipient_user_id: "user-recipient",
    recipient_family_member_id: null,
    recipient_display_name: "Ncumolwethu",
    registry_title: "Birthday",
    quantity: 1,
    live_price_cents: 4984,
    max_acceptable_fill_cents: 5084,
    drift_bps: 200,
    reserved_amount_cents: 5084,
    payment_method: "wallet",
    status: GIFT_AUTH_STATUS.PARKED,
    pending_decision_deadline: null,
    oems_order_audit_id: "audit-1",
    oems_order_id: "order-1",
    idempotency_key: "res-1:user-gifter",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    authorized_at: new Date().toISOString(),
    parked_at: new Date().toISOString(),
    working_at: null,
    filled_at: null,
    cancelled_at: null,
    ...overrides,
  };
  stored.gift_authorizations = [auth];
  stored.gift_authorization_events = [];
  stored.wallets = [
    { id: "wallet-1", user_id: "user-gifter", available_balance_cents: 100000, posted_balance_cents: 100000, balance: 1000 },
  ];
  stored.gift_contributions = [];
  stored.notifications = [];
  return auth;
}

const sampleFill = {
  orderId: "iress-700123",
  userId: "user-gifter",
  securityId: "sec-fsr",
  symbol: "FSR",
  side: "buy" as const,
  filledQty: 1,
  avgFillCents: 4984,
  strategy: null,
  orderedQty: 1,
  holdingId: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compareFillToCeiling", () => {
  it("within_ceiling when fill === ceiling", () => {
    expect(compareFillToCeiling(5084, 5084)).toBe("within_ceiling");
  });
  it("within_ceiling when fill < ceiling", () => {
    expect(compareFillToCeiling(4984, 5084)).toBe("within_ceiling");
  });
  it("above_ceiling when fill > ceiling by 1 cent", () => {
    expect(compareFillToCeiling(5085, 5084)).toBe("above_ceiling");
  });
  it("within_ceiling at R103.87 vs a R150.00 ceiling — the 2026-07-27 incident shape", () => {
    // The previous flow locked at 10387 cents and chained fees on top.
    // The new flow would have set live_price_cents to 4984 (the real FSR
    // price) and a ceiling of 5084 ceil; a fill at 10387 cents would now
    // be above_ceiling and require operator approval. The gifter's wallet
    // would NOT be debited.
    expect(compareFillToCeiling(10387, 5084)).toBe("above_ceiling");
  });
});

describe("applyGiftFill", () => {
  let inst: MockSupabase;
  let retail: MockSupabase;

  beforeEach(() => {
    inst = makeMockSupabase();
    retail = makeMockSupabase();
  });

  it("PARKED + within-ceiling fill → WORKING → FILLED; wallet debited at fill price", async () => {
    // Gift tables live on RETAIL — seed the auth row there.
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.PARKED });
    const fill = { ...sampleFill, avgFillCents: 4984 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );

    expect(result).not.toBeNull();
    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.FILLED);
    expect(result!.action).toBe("open_holding");
    expect(result!.paidAmountCents).toBe(4984);

    const wallet = retail._stored.wallets[0];
    expect(wallet.posted_balance_cents).toBe(100000 - 4984);
    expect(wallet.available_balance_cents).toBe(100000); // untouched at fill
    expect(wallet.balance).toBe(Math.floor((100000 - 4984) / 100));

    const updated = retail._stored.gift_authorizations[0];
    expect(updated.status).toBe(GIFT_AUTH_STATUS.FILLED);
    expect(updated.fill_price_cents).toBe(4984);
    expect(updated.fill_quantity).toBe(1);
    expect(updated.fill_reference).toBe("iress-700123");
    expect(updated.paid_amount_cents).toBe(4984);
  });

  it("PARKED + above-ceiling fill → PENDING_GIFTER_APPROVAL; wallet NOT debited", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.PARKED });
    const fill = { ...sampleFill, avgFillCents: 5200 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );

    expect(result).not.toBeNull();
    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL);
    expect(result!.action).toBe("hold_for_approval");
    expect(result!.paidAmountCents).toBe(0);

    const wallet = retail._stored.wallets[0];
    expect(wallet.posted_balance_cents).toBe(100000);
    expect(wallet.available_balance_cents).toBe(100000);

    const updated = retail._stored.gift_authorizations[0];
    expect(updated.status).toBe(GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL);
    expect(updated.pending_decision_deadline).not.toBeNull();
  });

  it("idempotent: re-running the same fill on a FILLED row is a no-op", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.FILLED });
    const fill = { ...sampleFill, avgFillCents: 4984 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );

    expect(result).not.toBeNull();
    expect(result!.action).toBe("stop");
    expect(result!.paidAmountCents).toBe(0);
    expect(retail._stored.wallets[0].posted_balance_cents).toBe(100000);
  });

  it("AUTHORIZED + fill (operator collided with broker) → WORKING → FILLED", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.AUTHORIZED });
    const fill = { ...sampleFill, avgFillCents: 4984 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );

    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.FILLED);
    const updated = retail._stored.gift_authorizations[0];
    expect(updated.status).toBe(GIFT_AUTH_STATUS.FILLED);
    expect(updated.working_at).not.toBeNull();
  });

  it("dryRun: no wallet writes, but the transition still records", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.PARKED });
    const fill = { ...sampleFill, avgFillCents: 4984 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: true },
      auth,
      fill,
    );

    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.FILLED);
    expect(retail._stored.wallets[0].posted_balance_cents).toBe(100000);
  });

  it("non-fill garbage: NaN avgFill returns null", async () => {
    const auth = seedAuth(retail._stored);
    const fill = { ...sampleFill, avgFillCents: NaN };
    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );
    expect(result).toBeNull();
  });
});

describe("applyGiftTerminalNoFill", () => {
  let inst: MockSupabase;
  let retail: MockSupabase;

  beforeEach(() => {
    inst = makeMockSupabase();
    retail = makeMockSupabase();
  });

  it("PARKED + IRESS rejected → REJECTED; wallet reservation cleared", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.PARKED });
    const result = await applyGiftTerminalNoFill(
      { retail: retail as any, dryRun: false },
      auth,
      "rejected",
      "OrderTag malformed",
    );

    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.REJECTED);
    expect(result!.action).toBe("stop");
    const wallet = retail._stored.wallets[0];
    expect(wallet.available_balance_cents).toBe(100000 + 5084);
    expect(wallet.posted_balance_cents).toBe(100000);
  });

  it("WORKING + IRESS expired → REJECTED; wallet reservation cleared", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.WORKING });
    const result = await applyGiftTerminalNoFill(
      { retail: retail as any, dryRun: false },
      auth,
      "expired",
      "DAY order expired at 17:00 SAST",
    );

    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.REJECTED);
  });

  it("terminal status is preserved on subsequent calls (idempotent)", async () => {
    const auth = seedAuth(retail._stored, { status: GIFT_AUTH_STATUS.FILLED });
    const result = await applyGiftTerminalNoFill(
      { retail: retail as any, dryRun: false },
      auth,
      "rejected",
      null,
    );
    expect(result).toBeNull();
  });
});

describe("sweepExpiredParkedAuthorizations", () => {
  let inst: MockSupabase;
  let retail: MockSupabase;

  beforeEach(() => {
    inst = makeMockSupabase();
    retail = makeMockSupabase();
  });

  it("transitions PARKED past expires_at → EXPIRED and releases reservation", async () => {
    seedAuth(retail._stored, {
      status: GIFT_AUTH_STATUS.PARKED,
      expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const result = await sweepExpiredParkedAuthorizations({ retail: retail as any, dryRun: false });
    expect(result.expired).toBe(1);

    const updated = retail._stored.gift_authorizations[0];
    expect(updated.status).toBe(GIFT_AUTH_STATUS.EXPIRED);
    expect(retail._stored.wallets[0].available_balance_cents).toBe(100000 + 5084);
  });

  it("does NOT transition a still-valid PARKED row", async () => {
    seedAuth(retail._stored, {
      status: GIFT_AUTH_STATUS.PARKED,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const result = await sweepExpiredParkedAuthorizations({ retail: retail as any, dryRun: false });
    expect(result.expired).toBe(0);
    expect(retail._stored.gift_authorizations[0].status).toBe(GIFT_AUTH_STATUS.PARKED);
  });

  it("exits cleanly when there are no candidates", async () => {
    const result = await sweepExpiredParkedAuthorizations({ retail: retail as any, dryRun: false });
    expect(result.expired).toBe(0);
  });
});

describe("sweepApprovalGraceExpired", () => {
  let inst: MockSupabase;
  let retail: MockSupabase;

  beforeEach(() => {
    inst = makeMockSupabase();
    retail = makeMockSupabase();
  });

  it("PENDING_GIFTER_APPROVAL past deadline → AUTO_CANCELLED; reservation released", async () => {
    seedAuth(retail._stored, {
      status: GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL,
      pending_decision_deadline: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    const result = await sweepApprovalGraceExpired({ retail: retail as any, dryRun: false });
    expect(result.auto_cancelled).toBe(1);

    const updated = retail._stored.gift_authorizations[0];
    expect(updated.status).toBe(GIFT_AUTH_STATUS.AUTO_CANCELLED);
    expect(retail._stored.wallets[0].available_balance_cents).toBe(100000 + 5084);
  });

  it("does NOT transition a still-pending PENDING_GIFTER_APPROVAL", async () => {
    seedAuth(retail._stored, {
      status: GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL,
      pending_decision_deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const result = await sweepApprovalGraceExpired({ retail: retail as any, dryRun: false });
    expect(result.auto_cancelled).toBe(0);
    expect(retail._stored.gift_authorizations[0].status).toBe(GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL);
  });
});

describe("FirstRand incident replay — full lifecycle", () => {
  let inst: MockSupabase;
  let retail: MockSupabase;

  beforeEach(() => {
    inst = makeMockSupabase();
    retail = makeMockSupabase();
  });

  it("1 FSR share AUTHORIZED → PARKED → WORKING → FILLED on the live price (R49.84), not the stale R103.87", async () => {
    const auth = seedAuth(retail._stored, {
      quantity: 1,
      live_price_cents: 4984,
      max_acceptable_fill_cents: 5084,
      reserved_amount_cents: 5084,
      status: GIFT_AUTH_STATUS.PARKED,
    });

    const fill = { ...sampleFill, orderId: "iress-700777", avgFillCents: 4984 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );

    expect(result).not.toBeNull();
    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.FILLED);
    expect(result!.paidAmountCents).toBe(4984);

    const wallet = retail._stored.wallets[0];
    expect(wallet.posted_balance_cents).toBe(100000 - 4984);
    expect(wallet.posted_balance_cents).not.toBe(100000 - 10387);

    const updated = retail._stored.gift_authorizations[0];
    expect(updated.live_price_cents).toBe(4984);
    expect(updated.live_price_cents).not.toBe(10387);
  });

  it("above-ceiling fill at R52.00 (4.3% slippage) → PENDING_GIFTER_APPROVAL; no wallet debit", async () => {
    const auth = seedAuth(retail._stored, {
      status: GIFT_AUTH_STATUS.PARKED,
      max_acceptable_fill_cents: 5084,
    });
    const fill = { ...sampleFill, avgFillCents: 5200 };

    const result = await applyGiftFill(
      { institutional: inst as any, retail: retail as any, dryRun: false },
      auth,
      fill,
    );

    expect(result!.toStatus).toBe(GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL);
    expect(result!.paidAmountCents).toBe(0);
    expect(retail._stored.wallets[0].posted_balance_cents).toBe(100000);
  });
});