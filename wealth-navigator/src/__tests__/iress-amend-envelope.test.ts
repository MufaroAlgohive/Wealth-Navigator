import { describe, expect, it } from "vitest";

import {
  buildSoapEnvelope,
  IRESS_NS,
  type SoapCallSpec,
} from "@/lib/iress/transport";

/**
 * Regression: OrderAmend2 wire-shape contract.
 *
 * 2026-07-15 walkthrough: Andre reported volume amends reached the broker
 * with no error (HTTP 200, ErrorNumber=0) but the order's volume never
 * actually changed. Root cause — the build emitted a flat envelope:
 *
 *   <Parameters>
 *     <OrderNumber>...</OrderNumber>
 *     <Volume>...</Volume>
 *   </Parameters>
 *
 * The IRESS V4 spec (`Documentation & Vision/iress-v4-docs/13-soap-examples/order-amend-2.request.xml`)
 * requires the amendable fields to be wrapped in a nested `<Order>` element:
 *
 *   <Parameters>
 *     <Order>
 *       <OrderNumber>...</OrderNumber>
 *       <Volume>...</Volume>
 *     </Order>
 *   </Parameters>
 *
 * Hermes's XML parser accepted the flat shape enough to return a success
 * envelope (echoing the OrderNumber), but couldn't associate Volume with
 * any field on the order — so the amend was a silent no-op at the broker.
 *
 * These tests pin the wire shape so any future refactor that drops the
 * `<Order>` wrapper fails CI before reaching Hermes.
 */
describe("OrderAmend2 wire envelope shape", () => {
  it("volume-only amend is wrapped under <Parameters><Order>", () => {
    const spec: SoapCallSpec = {
      method: "OrderAmend2",
      header: {
        ServiceSessionKey: "ssk",
        RequestID: "amd-1",
        Timeout: 25,
        WaitForResponse: true,
      },
      parameters: {
        Order: {
          OrderNumber: "1500152",
          Volume: 100,
        },
      },
    };
    const xml = buildSoapEnvelope(spec);
    expect(xml).toContain(`<OrderAmend2 xmlns="${IRESS_NS}">`);
    expect(xml).toContain("<Parameters>");
    expect(xml).toContain("<Order>");
    // OrderNumber + Volume must live inside <Order>, NOT directly in <Parameters>.
    expect(xml).toContain(
      `<Order><OrderNumber>1500152</OrderNumber><Volume>100</Volume></Order>`,
    );
    // Defensive: the flat shape that previously caused silent no-ops.
    expect(xml).not.toContain(
      `<Parameters><OrderNumber>1500152</OrderNumber>`,
    );
  });

  it("price + TIF amend stays under the same <Order> wrapper", () => {
    const spec: SoapCallSpec = {
      method: "OrderAmend2",
      header: { ServiceSessionKey: "ssk", RequestID: "amd-2" },
      parameters: {
        Order: {
          OrderNumber: "1500147",
          Price: 180.5,
          TimeInForce: "DAY",
        },
      },
    };
    const xml = buildSoapEnvelope(spec);
    expect(xml).toContain(
      `<Order><OrderNumber>1500147</OrderNumber><Price>180.5</Price><TimeInForce>DAY</TimeInForce></Order>`,
    );
  });

  it("amend with no fields still emits <Order><OrderNumber/></Order> (control case)", () => {
    const spec: SoapCallSpec = {
      method: "OrderAmend2",
      header: { ServiceSessionKey: "ssk", RequestID: "amd-3" },
      parameters: { Order: { OrderNumber: "1500147" } },
    };
    const xml = buildSoapEnvelope(spec);
    expect(xml).toContain(
      `<Order><OrderNumber>1500147</OrderNumber></Order>`,
    );
  });
});

describe("OrderDelete wire envelope shape (control — flat is correct here)", () => {
  // OrderDelete is genuinely flat per
  // `Documentation & Vision/iress-v4-docs/13-soap-examples/order-delete.request.xml`:
  //   <Parameters>
  //     <OrderNumber>...</OrderNumber>
  //     <AccountCode>...</AccountCode>
  //   </Parameters>
  // Pin this so a careless refactor doesn't add an <Order> wrapper here too.
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