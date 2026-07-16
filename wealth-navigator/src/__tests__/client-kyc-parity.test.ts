import { describe, expect, it } from "vitest";

import { deriveKyc } from "@/app/api/admin/clients/route";

describe("CRM client KYC parity", () => {
  it("uses the latest GREEN onboarding pack over a stale RED onboarding answer", () => {
    expect(
      deriveKyc(
        { kyc_status: "pending", sumsub_review_answer: "RED" },
        { kyc_verified: false, kyc_needs_resubmission: true },
        { review: { result: { reviewAnswer: "GREEN" }, reviewStatus: "completed" } },
      ),
    ).toBe("verified");
  });

  it("uses a pack YELLOW review as pending", () => {
    expect(
      deriveKyc(
        { kyc_status: "verified", sumsub_review_answer: "GREEN" },
        { kyc_verified: true, kyc_needs_resubmission: false },
        { review: { result: { reviewAnswer: "YELLOW" }, reviewStatus: "pending" } },
      ),
    ).toBe("pending");
  });

  it("falls back to the CRM onboarding status when no pack exists", () => {
    expect(deriveKyc({ kyc_status: "completed" }, undefined, null)).toBe("verified");
    expect(deriveKyc({ kyc_status: "pending" }, undefined, null)).toBe("pending");
    expect(deriveKyc({ kyc_status: "rejected" }, undefined, null)).toBe("rejected");
  });
});
