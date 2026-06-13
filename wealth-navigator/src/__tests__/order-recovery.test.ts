import { describe, expect, it, vi } from "vitest";

import { orderCreate3WithRecovery } from "@/lib/iress/order-recovery";
import { IressError } from "@/lib/iress/errors";
import type { IressClient, OrderCreate3Request } from "@/lib/iress/client";

function makeRequest(tag: string): OrderCreate3Request {
  return {
    ServiceSessionKey: "ssk",
    OrderTag: tag,
    Order: {
      AccountCode: "MINT-LIVE-001",
      SecurityCode: "NPN",
      Exchange: "JSE",
      BuySell: 1,
      OrderType: "LMT",
      Volume: 100,
      Price: 4180,
      Destination: "JSE",
      TimeInForce: "DAY",
    },
  };
}

function makeClient(overrides: Partial<IressClient> = {}): IressClient {
  return {
    iressSessionStart: vi.fn(),
    iressSessionEnd: vi.fn(),
    serviceSessionStart: vi.fn(),
    serviceSessionEnd: vi.fn(),
    pricingQuoteGet: vi.fn(),
    pricingQuoteGetUpdates: vi.fn(),
    timeSeriesGet2: vi.fn(),
    timeSeriesGet2Updates: vi.fn(),
    orderCreate3: vi.fn(),
    orderAmend2: vi.fn(),
    orderDelete: vi.fn(),
    orderNoGetByOrderTag: vi.fn(),
    orderPadGetByAccount: vi.fn(),
    orderPadGetByAccountUpdates: vi.fn(),
    bookingGetByOrganisation2: vi.fn(),
    ipsTransactionGetByAccount5: vi.fn(),
    targetIdGet: vi.fn(),
    targetIdStatusGet: vi.fn(),
    ...overrides,
  } as IressClient;
}

describe("orderCreate3WithRecovery", () => {
  it("returns the original response on a clean first call (no recovery, no delay)", async () => {
    const orderCreate3 = vi.fn(async () => ({ OrderNumber: "ORD-1", Status: "WORKING" as const }));
    const client = makeClient({ orderCreate3 });
    const sleep = vi.fn(async () => {});
    const res = await orderCreate3WithRecovery({
      client,
      request: makeRequest("tag-1"),
      sleep,
    });
    expect(res.response.OrderNumber).toBe("ORD-1");
    expect(res.recovered).toBe(false);
    expect(res.brokerAcceptedOnRecovery).toBe(false);
    expect(orderCreate3).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers via orderNoGetByOrderTag when the first call throws a transport fault and the broker accepted", async () => {
    const orderCreate3 = vi
      .fn<typeof mockFailingCreate>()
      .mockRejectedValueOnce(new IressError(666, "OrderCreate3", "SOAP fault — system error"))
      .mockResolvedValueOnce({ OrderNumber: "ORD-2", Status: "WORKING" as const });
    const orderNoGetByOrderTag = vi.fn(async () => ({
      OrderNumber: "ORD-2",
      OrderTag: "tag-2",
    }));
    const client = makeClient({
      orderCreate3: orderCreate3 as unknown as IressClient["orderCreate3"],
      orderNoGetByOrderTag,
    });
    const sleep = vi.fn(async () => {});
    const res = await orderCreate3WithRecovery({
      client,
      request: makeRequest("tag-2"),
      sleep,
    });
    expect(res.response.OrderNumber).toBe("ORD-2");
    expect(res.recovered).toBe(true);
    expect(res.brokerAcceptedOnRecovery).toBe(true);
    expect(orderCreate3).toHaveBeenCalledTimes(1);
    expect(orderNoGetByOrderTag).toHaveBeenCalledWith({
      ServiceSessionKey: "ssk",
      OrderTag: "tag-2",
    });
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("re-throws the transport error when the broker has not yet recognised the tag", async () => {
    const orderCreate3 = vi
      .fn<typeof mockFailingCreate>()
      .mockRejectedValueOnce(new IressError(666, "OrderCreate3", "fetch failed"));
    const orderNoGetByOrderTag = vi.fn(async () => ({ OrderNumber: "", OrderTag: "tag-3" }));
    const client = makeClient({
      orderCreate3: orderCreate3 as unknown as IressClient["orderCreate3"],
      orderNoGetByOrderTag,
    });
    await expect(
      orderCreate3WithRecovery({
        client,
        request: makeRequest("tag-3"),
        sleep: vi.fn(async () => {}),
      }),
    ).rejects.toMatchObject({ code: 666, method: "OrderCreate3" });
    expect(orderNoGetByOrderTag).toHaveBeenCalledOnce();
  });

  it("re-throws the original error when the recovery lookup itself fails", async () => {
    const orderCreate3 = vi
      .fn<typeof mockFailingCreate>()
      .mockRejectedValueOnce(new IressError(666, "OrderCreate3", "HTTP 500"));
    const orderNoGetByOrderTag = vi.fn(async () => {
      throw new IressError(25014, "OrderNoGetByOrderTag", "Iress session expired");
    });
    const client = makeClient({
      orderCreate3: orderCreate3 as unknown as IressClient["orderCreate3"],
      orderNoGetByOrderTag,
    });
    await expect(
      orderCreate3WithRecovery({
        client,
        request: makeRequest("tag-4"),
        sleep: vi.fn(async () => {}),
      }),
    ).rejects.toMatchObject({ code: 666, method: "OrderCreate3" });
  });

  it("does not attempt recovery for a non-transport IressError (e.g. 25010 method not entitled)", async () => {
    const orderCreate3 = vi
      .fn<typeof mockFailingCreate>()
      .mockRejectedValueOnce(new IressError(25010, "OrderCreate3", "Method not entitled"));
    const orderNoGetByOrderTag = vi.fn();
    const client = makeClient({
      orderCreate3: orderCreate3 as unknown as IressClient["orderCreate3"],
      orderNoGetByOrderTag: orderNoGetByOrderTag as unknown as IressClient["orderNoGetByOrderTag"],
    });
    await expect(
      orderCreate3WithRecovery({
        client,
        request: makeRequest("tag-5"),
        sleep: vi.fn(async () => {}),
      }),
    ).rejects.toMatchObject({ code: 25010 });
    expect(orderNoGetByOrderTag).not.toHaveBeenCalled();
  });

  it("treats raw network error messages (fetch failed / ETIMEDOUT / ECONNRESET) as transient", async () => {
    const orderCreate3 = vi
      .fn<typeof mockFailingCreate>()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce({ OrderNumber: "ORD-6", Status: "WORKING" as const });
    const orderNoGetByOrderTag = vi.fn(async () => ({ OrderNumber: "ORD-6", OrderTag: "tag-6" }));
    const client = makeClient({
      orderCreate3: orderCreate3 as unknown as IressClient["orderCreate3"],
      orderNoGetByOrderTag,
    });
    const res = await orderCreate3WithRecovery({
      client,
      request: makeRequest("tag-6"),
      sleep: vi.fn(async () => {}),
    });
    expect(res.recovered).toBe(true);
    expect(res.response.OrderNumber).toBe("ORD-6");
  });
});

// Helper signature used in the typed mock for the create fn above.
declare function mockFailingCreate(): Promise<{ OrderNumber: string; Status: "WORKING" }>;
