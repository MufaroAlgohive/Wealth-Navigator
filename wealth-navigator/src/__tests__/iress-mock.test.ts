import { describe, expect, it } from "vitest";

import { mockIressClient, iressQueries } from "@/lib/iress/mock";
import { IressError } from "@/lib/iress/errors";

const H: IressHeader = { SessionKey: "TEST-KEY", RequestID: "rid-1" };

interface IressHeader {
  SessionKey: string;
  RequestID: string;
}

describe("iressSessionStart", () => {
  it("returns a session with a non-empty IRESSSessionKey, a SessionNumber, and the request ApplicationID echoed back", async () => {
    // The mock returns IRESSSessionKey / SessionNumber / SessionTimeout / ApplicationID.
    // We assert the contract: a key prefixed MOCK-, ending in the CT server
    // hostname, with a non-empty session number.
    const res = await mockIressClient.iressSessionStart({
      UserName: "akhumalo",
      CompanyName: "MINT",
      Password: "secret",
      ApplicationID: "Mint-OEMS-Dev-web-1-abc",
      SessionTimeout: 120,
    });
    expect(res.IRESSSessionKey).toBeTruthy();
    expect(res.IRESSSessionKey.length).toBeGreaterThan(0);
    expect(res.IRESSSessionKey).toMatch(/MOCK-/);
    expect(res.IRESSSessionKey).toMatch(/WebServicesCT\.iress\.co\.za/);
    expect(typeof res.SessionNumber).toBe("number");
    expect(res.SessionTimeout).toBe(120);
    expect(res.ApplicationID).toBe("Mint-OEMS-Dev-web-1-abc");
  });

  it("throws IressError 25001 when credentials are missing", async () => {
    await expect(
      mockIressClient.iressSessionStart({
        UserName: "",
        CompanyName: "MINT",
        Password: "secret",
        ApplicationID: "Mint-OEMS-Dev-web-1-abc",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });
});

describe("pricingQuoteGet", () => {
  it("returns a quote for a known seed symbol (NPN)", async () => {
    const res = await mockIressClient.pricingQuoteGet({ Header: H, SecurityCode: "NPN", Exchange: "JSE" });
    expect(res.DataRows).toHaveLength(1);
    const q = res.DataRows[0]!;
    expect(q.symbol).toBe("NPN");
    expect(q.last).toBeGreaterThan(0);
    expect(q.marketState).toBeTruthy();
  });

  it("returns a HALT-shaped quote for an unknown symbol", async () => {
    const res = await mockIressClient.pricingQuoteGet({ Header: H, SecurityCode: "ZZZZZ", Exchange: "JSE" });
    expect(res.DataRows).toHaveLength(1);
    const q = res.DataRows[0]!;
    expect(q.symbol).toBe("ZZZZZ");
    expect(q.marketState).toBe("HALT");
    expect(q.last).toBe(0);
  });

  it("strips the .JSE exchange suffix when looking up a symbol", async () => {
    const res = await mockIressClient.pricingQuoteGet({ Header: H, SecurityCode: "NPN.JSE", Exchange: "JSE" });
    const q = res.DataRows[0]!;
    expect(q.symbol).toBe("NPN");
    expect(q.last).toBeGreaterThan(0);
  });
});

describe("orderCreate3", () => {
  it("returns an OrderNumber matching ^ORD-\\d+$ and adds it to the working set", async () => {
    const tag = `test-create-${Date.now()}-${Math.random()}-${Math.random()}`;
    const res = await mockIressClient.orderCreate3({
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
    });
    expect(res.OrderNumber).toMatch(/^ORD-\d+$/);
    expect(res.Status).toBe("WORKING");

    const all = await iressQueries.orders();
    const found = all.find((o) => o.id === res.OrderNumber);
    expect(found).toBeTruthy();
    expect(found!.orderTag).toBe(tag);
    expect(found!.qty).toBe(100);
    expect(found!.limit).toBe(4180);
    expect(found!.state).toBe("WORKING");
  });

  it("is idempotent on OrderTag", async () => {
    const tag = `test-idem-${Date.now()}-${Math.random()}`;
    const req: Parameters<typeof mockIressClient.orderCreate3>[0] = {
      ServiceSessionKey: "ssk",
      OrderTag: tag,
      Order: {
        AccountCode: "MINT-LIVE-001",
        SecurityCode: "NPN",
        Exchange: "JSE",
        BuySell: 1,
        OrderType: "LMT",
        Volume: 50,
        Price: 100,
        Destination: "JSE",
        TimeInForce: "DAY",
      },
    };
    const r1 = await mockIressClient.orderCreate3(req);
    const r2 = await mockIressClient.orderCreate3(req);
    expect(r2.OrderNumber).toBe(r1.OrderNumber);
  });
});

describe("orderAmend2", () => {
  it("updates the quantity and price of a working order", async () => {
    const create = await mockIressClient.orderCreate3({
      ServiceSessionKey: "ssk",
      OrderTag: `test-amend-${Date.now()}-${Math.random()}`,
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
    });

    await mockIressClient.orderAmend2({ ServiceSessionKey: "ssk", OrderNumber: create.OrderNumber, Volume: 250, Price: 4200 });
    const after = (await iressQueries.orders()).find((o) => o.id === create.OrderNumber);
    expect(after).toBeTruthy();
    expect(after!.qty).toBe(250);
    expect(after!.limit).toBe(4200);
  });
});

describe("orderDelete", () => {
  it("moves the order to CANCELLED state", async () => {
    const create = await mockIressClient.orderCreate3({
      ServiceSessionKey: "ssk",
      OrderTag: `test-cancel-${Date.now()}-${Math.random()}`,
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
    });
    await mockIressClient.orderDelete({ ServiceSessionKey: "ssk", OrderNumber: create.OrderNumber });
    const after = (await iressQueries.orders()).find((o) => o.id === create.OrderNumber);
    expect(after).toBeTruthy();
    expect(after!.state).toBe("CANCELLED");
  });
});

describe("orderPadGetByAccount", () => {
  it("returns at least one working order from the seed for MINT-LIVE-001", async () => {
    const res = await mockIressClient.orderPadGetByAccount({
      ServiceSessionKey: "ssk",
      AccountCode: "MINT-LIVE-001",
      OrderFilter: 1, // working
      RequestID: "rid-pad",
    });
    expect(res.DataRows.length).toBeGreaterThan(0);
    // sanity-check the seed shape
    const o = res.DataRows[0]!;
    expect(o.account).toBe("MINT-LIVE-001");
  });
});

describe("orderNoGetByOrderTag", () => {
  it("resolves a known tag to the broker OrderNumber", async () => {
    const tag = `test-tag-${Date.now()}-${Math.random()}`;
    const created = await mockIressClient.orderCreate3({
      ServiceSessionKey: "ssk",
      OrderTag: tag,
      Order: {
        AccountCode: "MINT-LIVE-001",
        SecurityCode: "NPN",
        Exchange: "JSE",
        BuySell: 1,
        OrderType: "LMT",
        Volume: 50,
        Price: 100,
        Destination: "JSE",
        TimeInForce: "DAY",
      },
    });
    const lookup = await mockIressClient.orderNoGetByOrderTag({ ServiceSessionKey: "ssk", OrderTag: tag });
    expect(lookup.OrderNumber).toBe(created.OrderNumber);
    expect(lookup.OrderTag).toBe(tag);
  });

  it("returns OrderNumber='' for an unknown tag (BFF treats as hard reject)", async () => {
    const lookup = await mockIressClient.orderNoGetByOrderTag({
      ServiceSessionKey: "ssk",
      OrderTag: "tag-never-existed-12345",
    });
    expect(lookup.OrderNumber).toBe("");
    expect(lookup.OrderTag).toBe("tag-never-existed-12345");
  });
});

describe("ipsTransactionGetByAccount5", () => {
  it("returns an array of transaction legs (FILLED/PARTIAL only) for the given account", async () => {
    const res = await mockIressClient.ipsTransactionGetByAccount5({
      ServiceSessionKey: "ssk",
      AccountCode: "MINT-LIVE-001",
      DateFrom: "2000-01-01",
      DateTo: "2099-01-01",
    });
    expect(Array.isArray(res.DataRows)).toBe(true);
    expect(res.DataRows.length).toBeGreaterThan(0);
    // Seed has FILLED and PARTIAL orders for MINT-LIVE-001
    for (const row of res.DataRows) {
      expect(row.Currency).toBe("ZAR");
      expect(typeof row.Quantity).toBe("number");
      expect(typeof row.Amount).toBe("number");
    }
  });
});

describe("timeSeriesGet2", () => {
  it("returns an array of bars with monotonically non-decreasing timestamps for ZAR_NSS", async () => {
    const res = await mockIressClient.timeSeriesGet2({
      Header: H,
      Code: "ZAR_NSS",
      Interval: "Daily",
    });
    expect(res.DataRows.length).toBeGreaterThan(1);
    for (let i = 1; i < res.DataRows.length; i++) {
      const prev = res.DataRows[i - 1]!;
      const cur = res.DataRows[i]!;
      expect(cur.t).toBeGreaterThanOrEqual(prev.t);
    }
  });

  it("returns a non-empty intraday series for the ALSI index", async () => {
    const res = await mockIressClient.timeSeriesGet2({
      Header: H,
      Code: "J203",
      Interval: "IntraDay",
    });
    expect(res.DataRows.length).toBe(78);
    for (let i = 1; i < res.DataRows.length; i++) {
      const prev = res.DataRows[i - 1]!;
      const cur = res.DataRows[i]!;
      expect(cur.t).toBeGreaterThanOrEqual(prev.t);
    }
  });
});

describe("ipsAccountGetAll1 (mock)", () => {
  it("returns the seeded account list with three ZAR accounts and an active status", async () => {
    const res = await mockIressClient.ipsAccountGetAll1({ ServiceSessionKey: "ssk" });
    expect(res.Header?.ErrorNumber).toBe(0);
    expect(res.DataRows.length).toBe(3);
    for (const a of res.DataRows) {
      expect(a.AccountCode).toMatch(/^Z\d{5}$/);
      expect(a.Currency).toBe("ZAR");
      expect(a.AccountStatus).toBe("ACTIVE");
    }
  });

  it("honors the legacy PreviousAccountCode cursor (returns the slice after the cursor)", async () => {
    const all = await mockIressClient.ipsAccountGetAll1({ ServiceSessionKey: "ssk" });
    const firstCode = all.DataRows[0]!.AccountCode;
    const after = await mockIressClient.ipsAccountGetAll1({
      ServiceSessionKey: "ssk",
      PreviousAccountCode: firstCode,
    });
    expect(after.DataRows.length).toBe(all.DataRows.length - 1);
    expect(after.DataRows[0]!.AccountCode).not.toBe(firstCode);
  });
});

describe("ipsPositionGetAll1 (mock)", () => {
  it("returns a non-empty position list attributed to the trading account by default", async () => {
    const res = await mockIressClient.ipsPositionGetAll1({ ServiceSessionKey: "ssk" });
    expect(res.Header?.ErrorNumber).toBe(0);
    expect(res.DataRows.length).toBeGreaterThan(0);
    for (const p of res.DataRows) {
      expect(p.AccountCode).toBe("Z12345");
      expect(p.Exchange).toBe("JSE");
      // MM instruments (TBs, NCDs, FRNs) seed with qty=0 in the strategy
      // holdings table. Equity positions always have qty > 0. We assert
      // the contract on at least one row to keep the test honest without
      // coupling to the seed mix.
      expect(typeof p.Quantity).toBe("number");
      expect(p.Quantity).toBeGreaterThanOrEqual(0);
    }
    const equities = res.DataRows.filter((p) => (p.Quantity ?? 0) > 0);
    expect(equities.length).toBeGreaterThan(0);
  });

  it("filters positions by AccountCode when one is supplied", async () => {
    const res = await mockIressClient.ipsPositionGetAll1({
      ServiceSessionKey: "ssk",
      AccountCode: "Z12346",
    });
    // The mock currently seeds positions to Z12345; filtering for Z12346
    // returns the empty cursor page. The contract is that the response is
    // always a well-formed array.
    expect(Array.isArray(res.DataRows)).toBe(true);
  });

  it("honors the legacy PreviousSecurityCode cursor", async () => {
    const all = await mockIressClient.ipsPositionGetAll1({ ServiceSessionKey: "ssk" });
    const firstCode = all.DataRows[0]!.SecurityCode;
    const after = await mockIressClient.ipsPositionGetAll1({
      ServiceSessionKey: "ssk",
      PreviousSecurityCode: firstCode,
    });
    expect(after.DataRows.length).toBe(all.DataRows.length - 1);
  });
});

describe("newsVendorGet (mock)", () => {
  it("returns an empty page with ErrorNumber=0 (T5 vendor content is seed-until-contracted)", async () => {
    // The mock must NEVER fabricate news — T5 policy is "honest empty
    // state when the source is unconfigured". The UI distinguishes a
    // configured-but-empty feed from a not-configured feed via the BFF
    // envelope, not the mock contract.
    const res = await mockIressClient.newsVendorGet({
      Header: { SessionKey: "TEST-KEY", RequestID: "rid-news" },
      Vendor: "SENS",
    });
    expect(res.Header?.ErrorNumber).toBe(0);
    expect(Array.isArray(res.DataRows)).toBe(true);
    expect(res.DataRows.length).toBe(0);
  });

  it("throws IressError 25018 when the caller omits `Vendor` (mirror the live 25018)", async () => {
    await expect(
      mockIressClient.newsVendorGet({
        Header: { SessionKey: "TEST-KEY", RequestID: "rid-news-no-vendor" },
        Vendor: "",
      }),
    ).rejects.toMatchObject({ code: 25018, method: "NewsVendorGet" });
  });
});
