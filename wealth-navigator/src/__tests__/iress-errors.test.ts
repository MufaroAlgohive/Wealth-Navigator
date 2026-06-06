import { describe, expect, it } from "vitest";

import { IressError, IRESS_SESSION_ERRORS } from "@/lib/iress/errors";

describe("IRESS_SESSION_ERRORS", () => {
  it("contains the 25001-25012 session codes the doc promises", () => {
    for (const code of [25001, 25002, 25003, 25004, 25005, 25006, 25007, 25008, 25009, 25010, 25011, 25012]) {
      expect(IRESS_SESSION_ERRORS[code as keyof typeof IRESS_SESSION_ERRORS]).toBeTruthy();
    }
  });

  it("has a non-empty human message for every entry in the table", () => {
    for (const [code, message] of Object.entries(IRESS_SESSION_ERRORS)) {
      expect(message, `code ${code} should have a message`).toBeTypeOf("string");
      expect((message as string).length, `code ${code} message should not be empty`).toBeGreaterThan(0);
    }
  });
});

describe("IressError", () => {
  it("carries the code, method, and a useful message", () => {
    const err = new IressError(25001, "IRESSSessionStart");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IressError);
    expect(err.name).toBe("IressError");
    expect(err.code).toBe(25001);
    expect(err.method).toBe("IRESSSessionStart");
    expect(err.message).toBe(IRESS_SESSION_ERRORS[25001]);
  });

  it("uses the provided message when one is supplied explicitly", () => {
    const err = new IressError(25029, "OrderAmend2", "Cannot amend order ORD-999");
    expect(err.code).toBe(25029);
    expect(err.method).toBe("OrderAmend2");
    expect(err.message).toBe("Cannot amend order ORD-999");
  });

  it("falls back to a generic message for unknown codes", () => {
    const err = new IressError(999999, "BogusMethod");
    expect(err.code).toBe(999999);
    expect(err.message).toMatch(/999999/);
  });
});
