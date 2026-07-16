import { describe, expect, it, vi } from "vitest";

import { createLiveIressClient } from "@/lib/iress/live";
import { buildSoapEnvelope, type SoapCallSpec, type SoapTransport } from "@/lib/iress/transport";

/**
 * OrderAmend2 wire-shape contract — verified EMPIRICALLY with Andre (IRESS)
 * against the live JSE/Hermes destination (2026-07-16, orders 1600159/1600160).
 *
 * Two things had to be right:
 *   1. The order is located by OrderNumber — the doc's `<Order><OrderNumber>`
 *      returns IRESS 20037 "You must specify an order number".
 *   2. The amend actually MUTATES — a plain `<Volume>` is silently ignored
 *      (Hermes returns success + OrderNumber but the volume never changes).
 *
 * The fix mirrors the WORKING OrderCreate3 exactly: IRESS's `<XxxArray><Xxx>`
 * convention with `Order`-prefixed names (OrderNumber / OrderVolume / OrderPrice
 * / Lifetime), all at the `<Parameters>` level. OrderPrice is WIRE CENTS
 * (rands x 100). These tests exercise the REAL orderAmend2 builder so a refactor
 * back to `<Order><Volume>` fails CI before it reaches Hermes.
 */

function makeCapturingClient() {
  const call = vi.fn().mockResolvedValue({
    result: {},
    header: { ErrorNumber: 0 },
    dataRows: [{ OrderNumber: "ok" }],
    firstRow: { OrderNumber: "ok" },
  });
  const transport = { call } as unknown as SoapTransport;
  const client = createLiveIressClient({ transport });
  return { client, call };
}

function capturedParameters(call: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (call.mock.calls[0]![0] as { parameters: Record<string, unknown> }).parameters;
}

describe("OrderAmend2 wire envelope shape (IRESS *Array convention, like OrderCreate3)", () => {
  it("volume amend → OrderNumberArray + OrderVolumeArray (not <Order><Volume>)", async () => {
    const { client, call } = makeCapturingClient();
    await client.orderAmend2({ ServiceSessionKey: "ssk", OrderNumber: "1600159", Volume: 150 });

    const params = capturedParameters(call);
    expect(params.OrderNumberArray).toEqual({ OrderNumber: "1600159" });
    expect(params.OrderVolumeArray).toEqual({ OrderVolume: 150 });

    const xml = buildSoapEnvelope({
      method: "OrderAmend2",
      header: { ServiceSessionKey: "ssk", RequestID: "amd-1" },
      parameters: params,
    });
    expect(xml).toContain(`<OrderNumberArray><OrderNumber>1600159</OrderNumber></OrderNumberArray>`);
    expect(xml).toContain(`<OrderVolumeArray><OrderVolume>150</OrderVolume></OrderVolumeArray>`);
    // The two shapes Hermes rejected / ignored.
    expect(xml).not.toContain(`<Order><OrderNumber>`); // 20037: order not found
    expect(xml).not.toContain(`<Order><Volume>`); // silent no-op: volume ignored
  });

  it("price amend → OrderPriceArray in CENTS (rands x 100)", async () => {
    const { client, call } = makeCapturingClient();
    await client.orderAmend2({
      ServiceSessionKey: "ssk",
      OrderNumber: "1500147",
      Price: 180.5,
      TimeInForce: "DAY",
    });
    const params = capturedParameters(call);
    expect(params.OrderNumberArray).toEqual({ OrderNumber: "1500147" });
    expect(params.OrderPriceArray).toEqual({ OrderPrice: 18050 }); // 180.50 rands → 18050 cents
    expect(params.LifetimeArray).toEqual({ Lifetime: 0 }); // DAY → 0
  });

  it("no amendable fields → only OrderNumberArray is sent", async () => {
    const { client, call } = makeCapturingClient();
    await client.orderAmend2({ ServiceSessionKey: "ssk", OrderNumber: "1500147" });
    const params = capturedParameters(call);
    expect(params.OrderNumberArray).toEqual({ OrderNumber: "1500147" });
    expect(params.OrderVolumeArray).toBeUndefined();
    expect(params.OrderPriceArray).toBeUndefined();
  });
});

describe("OrderDelete wire envelope shape (control — flat is correct here)", () => {
  it("emits <Parameters><OrderNumber/><AccountCode/></Parameters>", () => {
    const spec: SoapCallSpec = {
      method: "OrderDelete",
      header: { ServiceSessionKey: "ssk", RequestID: "del-1" },
      parameters: { OrderNumber: "1500150", AccountCode: "56378" },
    };
    const xml = buildSoapEnvelope(spec);
    expect(xml).toContain(
      `<Parameters><OrderNumber>1500150</OrderNumber><AccountCode>56378</AccountCode></Parameters>`,
    );
  });
});
