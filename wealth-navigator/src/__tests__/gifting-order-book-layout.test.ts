import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("OEM gifting order-book layout", () => {
  const page = readFileSync(resolve("src/app/admin/gifting/page.tsx"), "utf8");

  it("uses one gift-order disclosure with immediate asset and participant tables", () => {
    expect(page).toContain("function GiftOrderBookCard");
    expect(page).toContain("Gift order: {orderId}");
    expect(page).toContain("Assets under {gift.asset.name}");
    expect(page).toContain("Gift participants");
    expect(page).toContain("Full audit and timeline");
  });

  it("preserves the LIVE/UAT and wishlist controls", () => {
    expect(page).toContain('useState<"live" | "uat">("live")');
    expect(page).toContain('useState<"gifts" | "wishlists">("gifts")');
    expect(page).toContain("gift.environment === environment");
    expect(page).toContain("<WishlistPanel wishlists={wishlists}");
  });

  it("offers recovery for a claimed direct gift missing from the order book", () => {
    expect(page).toContain('gift.source === "claim"');
    expect(page).toContain('gift.claimState === "claimed"');
    expect(page).toContain("Recover to order book");
    expect(page).toContain('/api/admin/gifts/recover-orderbook');
  });

  it("only formats explicitly rand-denominated constituent price fields", () => {
    expect(page).toContain('explicitRands(asset, "avg_fill_rands", "avgFillRands")');
    expect(page).not.toContain('explicitRands(asset, "avg_fill")');
  });
});
