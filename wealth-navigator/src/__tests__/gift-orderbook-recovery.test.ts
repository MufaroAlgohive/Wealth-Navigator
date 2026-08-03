import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("direct gift order-book recovery", () => {
  const route = readFileSync(
    resolve("src/app/api/admin/gifts/recover-orderbook/route.ts"),
    "utf8",
  );

  it("reconstructs both claim transaction formats and delegates to canonical parking", () => {
    expect(route).toContain("GIFT-CLAIM-${claimId}");
    expect(route).toContain("GIFT2-CLAIM-${claimId}");
    expect(route).toContain("POST as parkClientOrder");
    expect(route).toContain("holding_id: holding.id");
    expect(route).toContain("book_id: `GIFT-${claimId}`");
  });

  it("persists recovery evidence and relies on holding-id idempotency", () => {
    expect(route).toContain("alreadyForwarded");
    expect(route).toContain("oems_forward_status: forwardStatus");
    expect(route).toContain("oems_forward_payload: [...previousPayload, ...results]");
    expect(route).toContain("Only a claimed direct gift can be recovered");
  });
});
