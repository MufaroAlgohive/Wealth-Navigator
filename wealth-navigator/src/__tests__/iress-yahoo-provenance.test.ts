import { describe, expect, it } from "vitest";

import {
  IRESS_STALE_FALLBACK_MS,
  isIressConfirmedFresh,
  isPriceStale,
  resolveSecurityPrices,
} from "@/lib/market-prices/fallback";

/**
 * Regression coverage for the IRESS -> Yahoo switch-back bug: `isPriceStale`
 * alone cannot tell a genuine IRESS write apart from the Yahoo fallback cron
 * (`/api/cron/yahoo-fundamentals`) refreshing `securities_c.updated_at` on
 * its own upkeep writes. `isIressConfirmedFresh` — and the price_source
 * label `resolveSecurityPrices` now returns — is the fix: a fresh row is
 * only read as "IRESS is back" when its provenance says so.
 */
describe("isIressConfirmedFresh", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const justNow = new Date(now - 1000).toISOString(); // 1s old — as fresh as it gets

  it("THE REGRESSION: a yahoo-sourced write is never evidence of IRESS recovery, however recent", () => {
    // Sanity check on the premise: plain recency alone WOULD say "fresh".
    expect(isPriceStale(justNow, now)).toBe(false);
    // But the switch-back condition must reject it once provenance says Yahoo.
    expect(isIressConfirmedFresh(justNow, "yahoo", now)).toBe(false);
  });

  it("a fresh iress-sourced write DOES clear the fallback", () => {
    expect(isIressConfirmedFresh(justNow, "iress", now)).toBe(true);
  });

  it("a stale iress-sourced write still does not clear the fallback", () => {
    const stale = new Date(now - IRESS_STALE_FALLBACK_MS - 1000).toISOString();
    expect(isIressConfirmedFresh(stale, "iress", now)).toBe(false);
  });

  it("unknown provenance (unmigrated DB / pre-provenance row) falls back to plain recency", () => {
    expect(isIressConfirmedFresh(justNow, null, now)).toBe(true);
    expect(isIressConfirmedFresh(justNow, undefined, now)).toBe(true);
    const stale = new Date(now - IRESS_STALE_FALLBACK_MS - 1000).toISOString();
    expect(isIressConfirmedFresh(stale, null, now)).toBe(false);
  });

  it("a missing timestamp is always stale regardless of provenance", () => {
    expect(isIressConfirmedFresh(null, "iress", now)).toBe(false);
  });
});

describe("resolveSecurityPrices — provenance-aware price_source label", () => {
  it("labels a fresh yahoo-sourced securities_c row 'yahoo', not 'securities_c'", async () => {
    const nowIso = new Date().toISOString(); // as fresh as it gets, right now
    const results = await resolveSecurityPrices({
      rows: [
        {
          id: "sec-1",
          symbol: "NPN",
          last_price: 418055,
          change_percent: 0.5,
          updated_at: nowIso,
          price_source: "yahoo",
        },
      ],
      intradayBySecurityId: new Map(),
    });
    expect(results).toHaveLength(1);
    // The old (buggy) behaviour would have labelled this "securities_c" —
    // i.e. "trust this row as confirmed-fresh" — purely because it was
    // recently touched, even though the touch was Yahoo's own upkeep write.
    expect(results[0]?.price_source).toBe("yahoo");
    // The DB value itself is still served (Yahoo's own recent price is
    // accurate) — only the provenance label changes, no live re-fetch or
    // value change is needed.
    expect(results[0]?.price_rands).toBe(4180.55);
  });

  it("labels a fresh iress-sourced securities_c row 'securities_c' (confirmed-fresh)", async () => {
    const nowIso = new Date().toISOString();
    const results = await resolveSecurityPrices({
      rows: [
        {
          id: "sec-2",
          symbol: "SBK",
          last_price: 20000,
          change_percent: 1.1,
          updated_at: nowIso,
          price_source: "iress",
        },
      ],
      intradayBySecurityId: new Map(),
    });
    expect(results[0]?.price_source).toBe("securities_c");
  });

  it("labels a fresh row with no provenance 'securities_c' (unmigrated-DB fallback, unchanged behaviour)", async () => {
    const nowIso = new Date().toISOString();
    const results = await resolveSecurityPrices({
      rows: [
        {
          id: "sec-3",
          symbol: "AGL",
          last_price: 55000,
          change_percent: -0.2,
          updated_at: nowIso,
          // price_source intentionally omitted — column not selected yet.
        },
      ],
      intradayBySecurityId: new Map(),
    });
    expect(results[0]?.price_source).toBe("securities_c");
  });
});
