/**
 * SumSub API helper. Ports `_sumsub.js` HMAC signing (ts + method + path,
 * HMAC-SHA256 with SUMSUB_APP_SECRET) → X-App-Token / X-App-Access-Sig /
 * X-App-Access-Ts headers. Server-only. No-ops (returns null) when unconfigured.
 */
import crypto from "node:crypto";

const HOST = "https://api.sumsub.com";

export function sumsubConfigured(): boolean {
  return !!(process.env.SUMSUB_APP_TOKEN && process.env.SUMSUB_APP_SECRET);
}

export async function sumsubFetch(method: string, pathWithQuery: string): Promise<Response | null> {
  const appToken = process.env.SUMSUB_APP_TOKEN;
  const appSecret = process.env.SUMSUB_APP_SECRET;
  if (!appToken || !appSecret) return null;
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", appSecret).update(ts + method + pathWithQuery).digest("hex");
  return fetch(`${HOST}${pathWithQuery}`, {
    method,
    headers: { Accept: "application/json", "X-App-Token": appToken, "X-App-Access-Sig": sig, "X-App-Access-Ts": ts },
  });
}

/** GET the applicant (incl. review status) by our externalUserId. */
export async function getApplicantByExternalId(externalUserId: string): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const path = `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`;
  const r = await sumsubFetch("GET", path);
  if (!r) return { ok: false, error: "SumSub credentials are not configured" };
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
