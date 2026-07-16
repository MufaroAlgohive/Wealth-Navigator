import { describe, expect, it, vi } from "vitest";

import { createLiveIressClient } from "@/lib/iress/live";
import { buildSoapEnvelope, type SoapCallSpec, type SoapTransport } from "@/lib/iress/transport";

/**
 * OrderAmend2 wire-shape contract — verified EMPIRICALLY against the live
 * JSE/Hermes destination (2026-07-16, order 1600159).
 *
 * The doc example (`13-soap-examples/order-amend-2.request.xml`) puts
 * `OrderNumber` inside `<Order>`. That is WRONG for this destination: Hermes
 * then can't find the order number and returns IRESS 20037 "You must specify
 * an order number." The working calls show the real contract:
 *   - OrderDelete (works) resolves `OrderNumber` at the `<Parameters>` level.
 *   - OrderCreate3 (works) nests the order fields inside `<Order>`.
 * So OrderAmend2 must be a HYBRID:
 *   <Parameters>
 *     <OrderNumber>1600159</OrderNumber>   <!-- flat, like OrderDelete -->
 *     <Order><Volume>150</Volume></Order>  <!-- fields nested, like OrderCreate3 -->
 *   </Parameters>
 *
 * These tests call the REAL `orderAmend2` builder via a captured transport, so
 * a refactor that moves OrderNumber back inside <Order> fails CI before Hermes.
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

describe("OrderAmend2 wire envelope shape (hybrid: OrderNumber flat, fields in <Order>)", () => {
  it("volume-only amend: OrderNumber at <Parameters>, Volume inside <Order>", async () => {
    const { client, call } = makeCapturingClient();
    await client.orderAmend2({ ServiceSessionKey: "ssk", OrderNumber: "1600159", Volume: 150 });

    const params = capturedParameters(call);
    expect(params.OrderNumber).toBe("1600159");
    expect(params.Order).toEqual({ Volume: 150 });

    const xml = buildSoapEnvelope({
      method: "OrderAmend2",
      header: { ServiceSessionKey: "ssk", RequestID: "amd-1" },
      parameters: params,
    });
    expect(xml).toContain(
      `<Parameters><OrderNumber>1600159</OrderNumber><Order><Volume>150</Volume></Order></Parameters>`,
    );
    // The broken shape that produced IRESS 20037 (OrderNumber inside <Order>).
    expect(xml).not.toContain(`<Order><OrderNumber>`);
  });

  it("price + TIF amend: OrderNumber flat, both fields nested under <Order>", async () => {
    const { client, call } = makeCapturingClient();
    await client.orderAmend2({
      ServiceSessionKey: "ssk",
      OrderNumber: "1500147",
      Price: 180.5,
      TimeInForce: "DAY",
    });
    const params = capturedParameters(call);
    expect(params.OrderNumber).toBe("1500147");
    expect(params.Order).toEqual({ Price: 180.5, TimeInForce: "DAY" });
  });

  it("no amendable fields: OrderNumber only, no <Order> wrapper", async () => {
    const { client, call } = makeCapturingClient();
    await client.orderAmend2({ ServiceSessionKey: "ssk", OrderNumber: "1500147" });
    const params = capturedParameters(call);
    expect(params.OrderNumber).toBe("1500147");
    expect(params.Order).toBeUndefined();
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
    expect(xml).not.toContain("<Order><OrderNumber");
  });
});
