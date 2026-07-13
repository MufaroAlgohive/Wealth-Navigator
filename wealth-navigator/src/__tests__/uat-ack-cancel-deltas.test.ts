import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Regression test for the second bug Andre + Juan hit live (2026-07-13):
 *   "acknowledgements don't reach the UI"
 *   "cancels don't flow back"
 *
 * Symptom (Andre's wording, paraphrased from the call):
 *   "I just acknowledged one order on Hermes. The OEMS UI just kept
 *    showing WORKING. Refresh did nothing."
 *   "Did you receive the cancel?" → "Waiting for it to tick or do anything."
 *
 * Root cause #1 — OrderCreate3 stamped `status='working'` not
 * `status='pending_ack'` after the broker returned an OrderNumber. So the
 * audit row never exposed the new 8-state lifecycle, and the SSE hub's
 * lastState seeded with "working" masked the very-first poll-cycle's
 * "pending_ack" delta when it did eventually fire.
 *
 * Root cause #2 — `OrderDelete` had no OEMS-side cancel endpoint (the
 * `/api/admin/orderbook/cancel` BFF route + UI button DID NOT EXIST).
 * Cancels could only be issued by clicking cancel in Hermes, which never
 * reached `oems_order_audit`. Even with the poller running filter=3 (ALL),
 *   a Hermes-side cancel would still take up to 30s to land.
 *
 * Fixes verified here (2026-07-13):
 *   1. Worker's `POST /uat/send-to-market` now stamps the audit row with
 *      `status='pending_ack'` (not 'working') after a successful
 *      OrderCreate3.
 *   2. Worker publishes an SSE delta on the UAT execution hub with
 *      `state='pending_ack'` immediately after OrderCreate3 returns.
 *   3. Worker's `POST /orders/cancel` now publishes an SSE delta with
 *      `state='cancelled'` so the UI flips immediately (rather than
 *      waiting for the next poll).
 *
 * These tests mount the worker's HTTP API in-process on an ephemeral
 * port, so they exercise the actual route handlers (auth, body parsing,
 * audit stamp, IRESS call, hub publish) end-to-end.
 */

const ORIGINAL_ENV = { ...process.env };

// Mutable container so the vi.hoisted mock factory can hand out the
// test-controlled IRESS double without capturing per-test locals (vitest
// hoists `vi.mock` calls and the factory must not close over them).
const iressDouble = vi.hoisted(() => {
  const createCalls: OrderCreateCall[] = [];
  const deleteCalls: OrderDeleteCall[] = [];
  let pendingFail: { errorNumber: number; description: string } | null = null;
  return {
    state: {
      createCalls,
      deleteCalls,
      get pendingFail() {
        return pendingFail;
      },
      set pendingFail(v) {
        pendingFail = v;
      },
    },
    getIressClient: () => ({
      orderCreate3: async (req: OrderCreateCall) => {
        createCalls.push(req);
        const f = pendingFail;
        pendingFail = null;
        if (f) {
          return { OrderNumber: "", ErrorNumber: f.errorNumber, ErrorDescription: f.description };
        }
        return { OrderNumber: "1500001" };
      },
      orderDelete: async (req: OrderDeleteCall) => {
        deleteCalls.push(req);
        return {};
      },
      orderNoGetByOrderTag: async () => ({ OrderNumber: "" }),
    }),
  };
});

interface OrderCreateCall {
  Order: Record<string, unknown>;
  OrderTag: string;
}
interface OrderDeleteCall {
  OrderNumber: string;
}

// Mock the IRESS adapter that the http-api route handler imports. The
// factory hands back our test double so every OrderCreate3/OrderDelete
// call is intercepted.
vi.mock("../../src/lib/iress/index", () => ({
  getIressClient: () => iressDouble.getIressClient(),
  createLiveIressClient: () => iressDouble.getIressClient(),
}));

interface UpdateCall {
  table: string;
  filter: string;
  payload: Record<string, unknown>;
}
interface SelectRowResult {
  data: unknown;
  error: { message: string } | null;
}

function makeSupabaseStub(opts: { seededRow: Record<string, unknown> | null } = { seededRow: null }): {
  client: SupabaseClient;
  updates: UpdateCall[];
  setSeededRow: (row: Record<string, unknown> | null) => void;
} {
  const updates: UpdateCall[] = [];
  let seededRow: Record<string, unknown> | null = opts.seededRow;

  const client = {
    from: (_table: string) => ({
      select: () => {
        const selBuilder = {
          eq: () => selBuilder,
          or: () => selBuilder,
          maybeSingle: async (): Promise<SelectRowResult> => ({ data: seededRow, error: null }),
          limit: () =>
            Promise.resolve({
              data: seededRow ? [seededRow] : [],
              error: null,
            }),
        };
        return selBuilder;
      },
      update: (rows: Record<string, unknown>) => {
        const updateCall: UpdateCall = {
          table: _table,
          filter: "*",
          payload: rows,
        };
        const builder: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            updateCall.filter = `${col}=${val}`;
            return builder;
          },
          then: (resolve: (v: { error: null }) => void) => {
            updates.push(updateCall);
            resolve({ error: null });
          },
        };
        return builder;
      },
    }),
  };

  return {
    client: client as unknown as SupabaseClient,
    updates,
    setSeededRow: (row) => {
      seededRow = row;
    },
  };
}

interface HubCall {
  state: string;
  filled: number;
  iressOrderNumber: string;
  orderAuditId: string | null;
  raw?: Record<string, unknown>;
  // 2026-07-13 — Transcript gap (23:40 / 26:21): SSE deltas carry the
  // lastAction + IRESS error fields so the UI's new Action + Error
  // columns update without a poll cycle.
  lastAction?: string | null;
  lastActionAt?: string | null;
  iressErrorNumber?: number | null;
  iressErrorDescription?: string | null;
}

/**
 * Subscribe to the worker's singleton UatExecutionHub and capture
 * every delta published. Returns an unsubscribe fn + a snapshot bag.
 * We attach a fresh subscriber per test, and unsubscribe during teardown
 * so the hub's internal Set doesn't leak between tests.
 */
async function attachHubRecorder(): Promise<{
  published: HubCall[];
  unsubscribe: () => void;
}> {
  const { uatExecutionHub } = await import("../../workers/iress-ingest/src/order-poller");
  const published: HubCall[] = [];
  const unsubscribe = uatExecutionHub.subscribe((delta: unknown) => {
    const d = delta as HubCall;
    published.push(d);
  });
  return { published, unsubscribe };
}

function makeSessionStub(): {
  session: {
    getSession: () => Promise<{ serviceKeys: { IOSPlus: string } }>;
    invalidate: () => void;
  };
} {
  return {
    session: {
      getSession: async () => ({ serviceKeys: { IOSPlus: "ios-key-1" } }),
      invalidate: () => {
        /* noop */
      },
    },
  };
}

async function mountWorker(opts: {
  supabase: SupabaseClient;
  session: ReturnType<typeof makeSessionStub>["session"];
}): Promise<{ port: number; close: () => Promise<void> }> {
  const http = await import("node:http");
  const { handleRequest } = await import("../../workers/iress-ingest/src/http-api");
  const server = http.createServer((req, res) => {
    void handleRequest(
      req,
      res,
      {
        env: {
          iressMode: "live",
          workerId: "test-worker",
          iressAccountCode: "MINT-LIVE-001",
          uatAccountCode: "56378",
          uatMode: true,
        },
        supabase: opts.supabase,
        sessions: opts.session as never,
      } as never,
      () => undefined,
      undefined,
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function resetIressDouble() {
  iressDouble.state.createCalls.length = 0;
  iressDouble.state.deleteCalls.length = 0;
  iressDouble.state.pendingFail = null;
}

describe("OrderCreate3 ack → SSE delta + audit.pending_ack (Juan + Andre 2026-07-13)", () => {
  beforeEach(() => {
    process.env.IRESS_WORKER_DRY_RUN = "0";
    process.env.SUPABASE_ALLOW_WRITES = "1";
    process.env.IRESS_UAT_MODE = "true";
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
    resetIressDouble();
  });

  it("POST /uat/send-to-market stamps audit.status='pending_ack' AND publishes a pending_ack delta", async () => {
    resetIressDouble();
    const supa = makeSupabaseStub({
      seededRow: {
        id: "audit-row-1",
        order_id: "OB-DEMO-1",
        client_account: "56378",
        symbol: "SOL",
        side: "buy",
        quantity: 400,
        price_cents: 17700,
        status: "working",
        source: "UAT",
        payload: { book_id: "UAT-ack-test", strategy: "UAT-ack-test", limitPrice: 177 },
        result_payload: {},
      },
    });
    const { published, unsubscribe } = await attachHubRecorder();
    const { session } = makeSessionStub();
    const server = await mountWorker({
      supabase: supa.client,
      session,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/uat/send-to-market`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order_audit_id: "audit-row-1",
          broker_destination: "JSE",
        }),
      });
      const body = (await res.json()) as { ok?: boolean; iressOrderNumber?: string; code?: string };
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.iressOrderNumber).toBe("1500001");

      // 1. The audit row was stamped with status='pending_ack'.
      const stampCall = supa.updates.find((u) => u.payload && "status" in u.payload);
      expect(stampCall, "expected at least one update to oems_order_audit").toBeTruthy();
      expect(stampCall?.payload.status).toBe("pending_ack");
      // 2. The broker OrderNumber is stamped into payload + result_payload.
      expect(
        (stampCall?.payload.payload as Record<string, unknown>)?.iress_order_number,
      ).toBe("1500001");
      // 3. The hub received a pending_ack delta.
      expect(published.length).toBeGreaterThan(0);
      expect(published[0]?.state).toBe("pending_ack");
      expect(published[0]?.iressOrderNumber).toBe("1500001");
      expect(published[0]?.filled).toBe(0);
      unsubscribe();
    } finally {
      await server.close();
    }
  });

  it("POST /uat/send-to-market stamps status='rejected' when OrderCreate3 returns ErrorNumber", async () => {
    resetIressDouble();
    iressDouble.state.pendingFail = { errorNumber: 25014, description: "Not entitled" };
    const supa = makeSupabaseStub({
      seededRow: {
        id: "audit-row-2",
        order_id: "OB-DEMO-2",
        client_account: "56378",
        symbol: "SOL",
        side: "buy",
        quantity: 400,
        price_cents: 17700,
        status: "working",
        source: "UAT",
        payload: { book_id: "UAT-reject-test", strategy: "UAT-reject-test", limitPrice: 177 },
        result_payload: {},
      },
    });
    const { published, unsubscribe } = await attachHubRecorder();
    const { session } = makeSessionStub();
    const server = await mountWorker({
      supabase: supa.client,
      session,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/uat/send-to-market`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order_audit_id: "audit-row-2",
          broker_destination: "JSE",
        }),
      });
      const body = (await res.json()) as { ok?: boolean; status?: number; code?: string };
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(422);
      expect(body.ok).toBe(false);
      expect(body.code).toBe("order_rejected");
      expect(published.length).toBeGreaterThan(0);
      expect(published[0]?.state).toBe("rejected");
      unsubscribe();
    } finally {
      await server.close();
    }
  });
});

describe("OrderDelete cancel → SSE delta + audit.cancelled (Juan + Andre 2026-07-13)", () => {
  beforeEach(() => {
    process.env.IRESS_WORKER_DRY_RUN = "0";
    process.env.SUPABASE_ALLOW_WRITES = "1";
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
    resetIressDouble();
  });

  it("POST /orders/cancel publishes a cancelled delta AND stamps audit.status='cancelled'", async () => {
    resetIressDouble();
    const supa = makeSupabaseStub({ seededRow: null });
    const { published, unsubscribe } = await attachHubRecorder();
    const { session } = makeSessionStub();
    const server = await mountWorker({
      supabase: supa.client,
      session,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/orders/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: "56378", orderId: "1500118" }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: { code: string; message: string }; message?: string };
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(200);
      expect(body.ok).toBe(true);

      // 1. The worker's HTTP API forwarded to IRESS OrderDelete with the
      //    correct OrderNumber.
      expect(iressDouble.state.deleteCalls.length).toBe(1);
      expect(iressDouble.state.deleteCalls[0]?.OrderNumber).toBe("1500118");

      // 2. The audit row was stamped with status='cancelled'. The seeded
      //    audit row here is null (no-op select), so the worker issues
      //    two updates — both on order_id AND on payload->>iress_order_number.
      const cancelUpdates = supa.updates.filter(
        (u) => u.payload && u.payload.status === "cancelled",
      );
      expect(cancelUpdates.length, "expected at least one cancel update").toBeGreaterThan(0);

      // 3. The hub received a cancelled delta.
      const cancelled = published.find((d) => d.state === "cancelled");
      expect(cancelled, "expected hub delta with state=cancelled").toBeTruthy();
      expect(cancelled?.iressOrderNumber).toBe("1500118");

      // 4. Transcript gap #2 (26:21): the cancelled SSE delta MUST carry
      //    a one-liner `lastAction` so the UI's new Action column updates
      //    without a poll cycle.
      expect(cancelled?.lastAction).toBe("Cancelled by trader (OrderDelete)");
      expect(typeof cancelled?.lastActionAt).toBe("string");

      // 5. Transcript gap #1 (23:40): the cancel updates carry a
      //    `lastAction` payload entry for the BFF to surface.
      const stampedUpdates = supa.updates.filter(
        (u) => typeof (u.payload?.payload as Record<string, unknown> | undefined)?.lastAction === "string",
      );
      expect(stampedUpdates.length, "expected lastAction stamped into payload").toBeGreaterThan(0);
      expect(
        (stampedUpdates[0]?.payload?.payload as Record<string, unknown>).lastAction,
      ).toBe("Cancelled by trader (OrderDelete)");

      unsubscribe();
    } finally {
      await server.close();
    }
  });

  it("OrderCreate3 rejection stamps audit.iressErrorNumber + publishes a rejected SSE delta (Transcript gap #1, 23:40)", async () => {
    // 2026-07-13 (Andre): "Investigation of missing full fill, cancel,
    // acknowledgement, and ERROR MESSAGE flows". The worker stamps
    // uatErrorNumber + uatErrorDescription on rejection — verify the
    // audit row carries them AND the SSE delta propagates them so the
    // UI's new Error column surfaces the actual broker reason.
    resetIressDouble();
    // Use the existing `pendingFail` injection pattern so the
    // getIressClient().orderCreate3 mock returns ErrorNumber=25014.
    iressDouble.state.pendingFail = {
      errorNumber: 25014,
      description: "Not entitled — application licence required for OrderCreate3 on this account.",
    };
    const supa = makeSupabaseStub({
      seededRow: {
        id: "audit-row-rejected",
        order_id: "OB-DEMO-REJ",
        client_account: "56378",
        symbol: "SOL",
        side: "buy",
        quantity: 400,
        price_cents: 17700,
        status: "working",
        source: "UAT",
        payload: { book_id: "UAT-reject", strategy: "UAT-reject", limitPrice: 177 },
        result_payload: {},
      },
    });
    const { published, unsubscribe } = await attachHubRecorder();
    const { session } = makeSessionStub();
    const server = await mountWorker({
      supabase: supa.client,
      session,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/uat/send-to-market`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order_audit_id: "audit-row-rejected",
          broker_destination: "JSE",
        }),
      });
      const body = (await res.json()) as { ok?: boolean; code?: string; status?: number };
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(422);
      expect(body.ok).toBe(false);
      expect(body.code).toBe("order_rejected");

      // 1. Audit row was stamped rejected AND carries the IRESS error.
      const stampCall = supa.updates.find(
        (u) => u.payload && u.payload.status === "rejected",
      );
      expect(stampCall, "expected audit stamped with status=rejected").toBeTruthy();
      expect(stampCall?.payload.status).toBe("rejected");
      const resultPayload = stampCall?.payload?.result_payload as Record<string, unknown>;
      expect(resultPayload.uatErrorNumber).toBe(25014);
      expect(resultPayload.uatErrorDescription).toContain("Not entitled");

      // 2. The hub received a rejected delta.
      const rejected = published.find((d) => d.state === "rejected");
      expect(rejected, "expected hub delta with state=rejected").toBeTruthy();
      expect(rejected?.lastAction).toContain("Rejected");
      expect(rejected?.lastAction).toContain("25014");
      unsubscribe();
    } finally {
      await server.close();
    }
  });
});
