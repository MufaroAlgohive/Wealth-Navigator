/**
 * Server-only IRESS Web Services credentials.
 *
 * These env vars authenticate the SOAP session against IRESS CT/prod
 * endpoints — they are NOT application user login credentials.
 */

export interface IressCredentials {
  userName: string;
  company: string;
  password: string;
}

/**
 * Split an Iress login code into SOAP `UserName` + `CompanyName`.
 *
 * Iress often communicates credentials as `user@company` (see support-queries
 * doc), but `IRESSSessionStart` expects separate fields — not the combined
 * string in `UserName`.
 */
export function parseIressUserCode(
  rawUserName: string,
  companyFromEnv?: string,
): Pick<IressCredentials, "userName" | "company"> {
  const at = rawUserName.indexOf("@");
  if (at > 0) {
    const userName = rawUserName.slice(0, at);
    const companyFromSuffix = rawUserName.slice(at + 1);
    const company =
      (companyFromEnv && companyFromEnv.trim()) ||
      companyFromSuffix ||
      "Mint";
    return { userName, company };
  }
  return {
    userName: rawUserName,
    company: (companyFromEnv && companyFromEnv.trim()) || "Mint",
  };
}

/** Optional trading account for OrderPadGetByAccount live queries. */
export function getIressAccountCodeFromEnv(): string {
  return process.env.IRESS_ACCOUNT_CODE ?? "";
}

/** Read IRESS WS credentials from process.env (server-side only). */
export function getIressCredentialsFromEnv(): IressCredentials {
  const rawUserName = process.env.IRESS_USERNAME ?? "";
  const { userName, company } = parseIressUserCode(
    rawUserName,
    process.env.IRESS_COMPANY_NAME,
  );
  return {
    userName,
    company,
    password: process.env.IRESS_PASSWORD ?? "",
  };
}

/**
 * Credentials for the PRODUCTION market-data session. Prefer the dedicated
 * `IRESS_PROD_*` login when set (in case prod uses a different credential),
 * otherwise reuse the shared `IRESS_*` login. Used only by the isolated prod
 * market-data session; the UAT orders session always uses the shared login.
 */
export function getIressProdCredentialsFromEnv(): IressCredentials {
  const rawUserName = process.env.IRESS_PROD_USERNAME ?? "";
  if (rawUserName.trim()) {
    const { userName, company } = parseIressUserCode(rawUserName, process.env.IRESS_PROD_COMPANY_NAME);
    return {
      userName,
      company,
      password: process.env.IRESS_PROD_PASSWORD ?? process.env.IRESS_PASSWORD ?? "",
    };
  }
  return getIressCredentialsFromEnv();
}
