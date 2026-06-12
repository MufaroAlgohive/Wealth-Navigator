import { afterEach, describe, expect, it, vi } from "vitest";

import { getIressCredentialsFromEnv, parseIressUserCode } from "@/lib/iress/config";

describe("getIressCredentialsFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads IRESS_USERNAME, IRESS_PASSWORD, IRESS_COMPANY_NAME from env", () => {
    vi.stubEnv("IRESS_USERNAME", "DFM@Mint");
    vi.stubEnv("IRESS_PASSWORD", "123");
    vi.stubEnv("IRESS_COMPANY_NAME", "Mint");

    const creds = getIressCredentialsFromEnv();
    expect(creds.userName).toBe("DFM");
    expect(creds.password).toBe("123");
    expect(creds.company).toBe("Mint");
  });

  it("parseIressUserCode splits user@company for SOAP fields", () => {
    expect(parseIressUserCode("DFM@Mint")).toEqual({
      userName: "DFM",
      company: "Mint",
    });
    expect(parseIressUserCode("DFM@Mint", "Mint")).toEqual({
      userName: "DFM",
      company: "Mint",
    });
    expect(parseIressUserCode("DFM", "Mint")).toEqual({
      userName: "DFM",
      company: "Mint",
    });
  });

  it("defaults company to Mint when IRESS_COMPANY_NAME is unset", () => {
    vi.stubEnv("IRESS_USERNAME", "user");
    vi.stubEnv("IRESS_PASSWORD", "pass");

    const creds = getIressCredentialsFromEnv();
    expect(creds.company).toBe("Mint");
  });

  it("defaults username and password to empty string when unset", () => {
    vi.stubEnv("IRESS_USERNAME", "");
    vi.stubEnv("IRESS_PASSWORD", "");

    const creds = getIressCredentialsFromEnv();
    expect(creds.userName).toBe("");
    expect(creds.password).toBe("");
  });
});
