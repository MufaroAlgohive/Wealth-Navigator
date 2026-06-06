import { describe, expect, it } from "vitest";

import { formatBps, formatPct, formatTime, formatZAR } from "@/lib/format";

describe("formatZAR", () => {
  it("formats sub-10k amounts with the en-ZA thousands separator and an R prefix", () => {
    // en-ZA uses a non-breaking space (U+00A0) as the thousands separator
    // and a comma as the decimal separator. So 1234.5 → "R 1 234,50".
    const out = formatZAR(1234.5);
    expect(out).toContain("R");
    expect(out).toMatch(/1[\s\u00A0]234/);
    expect(out).toMatch(/,50/);
  });

  it("uses the k suffix for amounts between 10k and 1m", () => {
    expect(formatZAR(250_000)).toBe("R250k");
  });

  it("uses the m suffix for amounts between 1m and 1bn", () => {
    expect(formatZAR(2_500_000)).toBe("R2.5m");
  });

  it("uses the bn suffix for amounts above 1bn", () => {
    expect(formatZAR(2_500_000_000)).toBe("R2.50bn");
  });

  it("handles zero without losing the currency prefix", () => {
    expect(formatZAR(0)).toContain("R");
    expect(formatZAR(0)).toMatch(/0/);
  });
});

describe("formatPct", () => {
  it("prefixes positive values with + and uses 2dp by default", () => {
    expect(formatPct(0.1234, 2)).toBe("+0.12%");
  });

  it("preserves a negative sign and zero-pads to the requested dp", () => {
    expect(formatPct(-0.05, 1)).toBe("-0.1%");
  });

  it("does not prefix zero with a sign", () => {
    expect(formatPct(0, 2)).toBe("0.00%");
  });
});

describe("formatBps", () => {
  it("multiplies by 100 and appends 'bp'", () => {
    expect(formatBps(0.0123, 1)).toBe("+1.2bp");
  });

  it("prefixes negative values with -", () => {
    expect(formatBps(-0.0021, 1)).toBe("-0.2bp");
  });

  it("does not prefix zero with a sign", () => {
    expect(formatBps(0, 1)).toBe("0.0bp");
  });
});

describe("formatTime", () => {
  it("returns an HH:mm:ss string in Africa/Johannesburg timezone for a known date", () => {
    // 2026-06-06 14:30:45 SAST (UTC+2, fixed)
    const out = formatTime(new Date("2026-06-06T12:30:45Z"));
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(out).toBe("14:30:45");
  });
});
