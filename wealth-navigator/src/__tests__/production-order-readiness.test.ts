import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { productionDestination, productionOrderBlockers } from "../../workers/iress-ingest/src/http-api";
import type { WorkerEnv } from "../../workers/iress-ingest/src/env";

/**
 * The production order lane sends REAL orders for REAL client money.
 * `productionOrderBlockers()` is the last thing between a config slip and a
 * trade, so it is tested condition by condition rather than as a single
 * happy/unhappy pair.
 *
 * The property that matters most is the DEFAULT: an environment that has not
 * been deliberately configured for live trading must be blocked. Every test
 * below starts from a fully-ready environment and breaks exactly one thing, so
 * a future change that accidentally drops a check fails here.
 */

function readyEnv(): WorkerEnv {
  // Only the fields productionOrderBlockers reads; the rest of WorkerEnv is
  // irrelevant to the gate.
  return {
    uatMode: false,
    iressAccountCode: "56378",
    iressMode: "live",
  } as unknown as WorkerEnv;
}

const KEYS = [
  "IRESS_PRODUCTION_ORDERS",
  "IRESS_PER_CLIENT_GUARD",
  "IRESS_PRODUCTION_DESTINATION",
  "IRESS_BASE_URL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  // A fully-configured production worker.
  process.env.IRESS_PRODUCTION_ORDERS = "1";
  process.env.IRESS_PER_CLIENT_GUARD = "1";
  process.env.IRESS_PRODUCTION_DESTINATION = "LONGMARK";
  process.env.IRESS_BASE_URL = "https://webservices.iress.co.za/v4";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("productionOrderBlockers", () => {
  it("passes only when every condition is met", () => {
    expect(productionOrderBlockers(readyEnv())).toEqual([]);
  });

  it("blocks a bare environment — live trading is never the default", () => {
    for (const k of KEYS) delete process.env[k];
    const blockers = productionOrderBlockers({
      uatMode: false,
      iressAccountCode: "",
      iressMode: "mock",
    } as unknown as WorkerEnv);
    // The switch, the guard, the account and the mode.
    expect(blockers.length).toBeGreaterThanOrEqual(4);
  });

  it("blocks when IRESS_PRODUCTION_ORDERS is unset", () => {
    delete process.env.IRESS_PRODUCTION_ORDERS;
    expect(productionOrderBlockers(readyEnv()).join(" ")).toContain("IRESS_PRODUCTION_ORDERS");
  });

  it.each(["0", "false", "yes", ""])("blocks when IRESS_PRODUCTION_ORDERS=%o", (v) => {
    process.env.IRESS_PRODUCTION_ORDERS = v;
    expect(productionOrderBlockers(readyEnv()).join(" ")).toContain("IRESS_PRODUCTION_ORDERS");
  });

  it("blocks when the worker is on the UAT lane", () => {
    const env = { ...readyEnv(), uatMode: true } as WorkerEnv;
    expect(productionOrderBlockers(env).join(" ")).toContain("IRESS_UAT_MODE");
  });

  it("blocks the CT test endpoint — an order there is not a real trade", () => {
    process.env.IRESS_BASE_URL = "https://webservices-ct.iress.co.za/v4";
    expect(productionOrderBlockers(readyEnv()).join(" ")).toContain("CT test endpoint");
  });

  it("allows the production endpoint", () => {
    process.env.IRESS_BASE_URL = "https://webservices.iress.co.za/v4";
    expect(productionOrderBlockers(readyEnv())).toEqual([]);
  });

  /**
   * The client-protecting blocker. Without the per-client guard a client's SELL
   * is validated against the desk omnibus, which can hold shares the client does
   * not — a naked short on their account. Production orders must be refused
   * outright rather than quietly falling back to the desk guard.
   */
  it("blocks when the per-client guard is off", () => {
    process.env.IRESS_PER_CLIENT_GUARD = "0";
    const msg = productionOrderBlockers(readyEnv()).join(" ");
    expect(msg).toContain("IRESS_PER_CLIENT_GUARD");
    expect(msg).toContain("desk omnibus");
  });

  /**
   * The destination is deliberately NOT a blocker. It defaults to
   * "LONGMARK CARE" — the value UAT proved, and the same fallback every other
   * order path in this codebase already uses. IRESS confirmed the production
   * move changes only the endpoint host, not the routing destination.
   * Requiring an env var whose value is already hard-coded elsewhere would only
   * produce a 409 at the worst possible moment.
   */
  it("does NOT block when the destination env var is absent — it defaults", () => {
    delete process.env.IRESS_PRODUCTION_DESTINATION;
    delete process.env.IRESS_DESTINATION;
    expect(productionOrderBlockers(readyEnv())).toEqual([]);
    expect(productionDestination()).toBe("LONGMARK CARE");
  });

  it("honours an explicit destination override", () => {
    process.env.IRESS_PRODUCTION_DESTINATION = "SOME OTHER ROUTE";
    expect(productionDestination()).toBe("SOME OTHER ROUTE");
    expect(productionOrderBlockers(readyEnv())).toEqual([]);
  });

  it("blocks when no broker account is configured", () => {
    const env = { ...readyEnv(), iressAccountCode: "" } as WorkerEnv;
    expect(productionOrderBlockers(env).join(" ")).toContain("IRESS_ACCOUNT_CODE");
  });

  it.each(["mock", "wsdl-stub", ""])("blocks when IRESS_MODE is %o", (mode) => {
    const env = { ...readyEnv(), iressMode: mode } as WorkerEnv;
    expect(productionOrderBlockers(env).join(" ")).toContain("IRESS_MODE");
  });

  it("names every unmet condition, not just the first", () => {
    delete process.env.IRESS_PRODUCTION_ORDERS;
    process.env.IRESS_PER_CLIENT_GUARD = "0";
    const blockers = productionOrderBlockers(readyEnv());
    // An operator mid-trading-window needs the whole list in one response.
    expect(blockers.length).toBe(2);
  });
});
