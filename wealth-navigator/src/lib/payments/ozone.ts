/**
 * Ozone payment provider — wallet top-ups.
 *
 * Mint OEM Finalisation Phase C6. Real Ozone API integration is blocked on
 * Tsie; the surface is wired end-to-end but the live HTTP transport returns
 * `unconfigured` until the contract lands.
 *
 * Three providers are shipped:
 *
 *   - `MockOzoneProvider`  — returns a fake redirect URL and flips the
 *                            in-memory transaction to `completed` after 5s.
 *                            Default in dev / unconfigured environments.
 *   - `LiveOzoneProvider`  — calls OZONE_API_URL. Returns `unconfigured`
 *                            status until `OZONE_API_URL` is set.
 *   - `getOzoneProvider()` — selector that wires the right impl from env
 *                            (`OZONE_MODE=mock|live`, default mock).
 *
 * The provider is consumed by:
 *   - `app/api/admin/eft/ozone-topup/route.ts`  (POST initiate)
 *   - `app/api/admin/eft/ozone-callback/route.ts` (POST webhook)
 *   - `app/oems/(banking)/wallet-topup/page.tsx` (UI; calls the BFF)
 */

import crypto from "node:crypto";

export interface InitiateTopupArgs {
  client_id: string;
  amount_cents: number;
  reference: string;
}

export interface InitiateTopupResult {
  redirect_url: string;
  transaction_id: string;
}

export type TopupStatus = "pending" | "completed" | "failed";

export interface CheckStatusResult {
  status: TopupStatus;
  reference?: string;
}

export type OzoneHealthStatus = "ok" | "degraded" | "unconfigured";

export interface OzoneHealth {
  status: OzoneHealthStatus;
  mode: "mock" | "live" | "unconfigured";
  message?: string;
}

export interface OzoneProvider {
  name: "ozone";
  initiateTopup(args: InitiateTopupArgs): Promise<InitiateTopupResult>;
  checkStatus(transaction_id: string): Promise<CheckStatusResult>;
  health(): Promise<OzoneHealth>;
}

/**
 * Module-local transaction store. The mock provider mutates this on the
 * 5 s flip so `checkStatus` reflects the simulated webhook. The shape is
 * intentionally permissive — `redirect_url` is whatever the mock produces.
 *
 * Tests can `resetOzoneMock()` to wipe state between cases.
 */
interface MockTransaction {
  transaction_id: string;
  redirect_url: string;
  status: TopupStatus;
  reference: string;
  amount_cents: number;
  client_id: string;
  created_at: string;
  completes_at: number; // ms timestamp
}

const mockTransactions = new Map<string, MockTransaction>();
const COMPLETION_DELAY_MS = 5_000;

/** Compute the simulated webhook signature for `MOCK` mode. Returns the HMAC
 *  in the same envelope (`sha256=...`) the live provider would emit, so the
 *  callback route's verification can be exercised offline.
 */
export function signOzoneCallback(body: string, secret: string): string {
  if (!secret) return "";
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

interface MockProviderOptions {
  /** Public base URL used to construct redirect URLs. Default `http://localhost:3000`. */
  baseUrl?: string;
  /** Optional webhook secret — when set, signed bodies are produced. */
  webhookSecret?: string;
}

export class MockOzoneProvider implements OzoneProvider {
  name = "ozone" as const;

  private readonly baseUrl: string;

  private readonly webhookSecret: string;

  constructor(opts: MockProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OZONE_REDIRECT_BASE_URL ?? "http://localhost:3000").replace(
      /\/+$/,
      "",
    );
    this.webhookSecret = opts.webhookSecret ?? process.env.OZONE_WEBHOOK_SECRET ?? "";
  }

  async initiateTopup(args: InitiateTopupArgs): Promise<InitiateTopupResult> {
    const transactionId = `oz-mock-${crypto.randomBytes(8).toString("hex")}`;
    const redirectUrl = `${this.baseUrl}/oems/banking/wallet-topup?ref=${encodeURIComponent(args.reference)}&tx=${transactionId}&status=callback`;
    const completesAt = Date.now() + COMPLETION_DELAY_MS;
    mockTransactions.set(transactionId, {
      transaction_id: transactionId,
      redirect_url: redirectUrl,
      status: "pending",
      reference: args.reference,
      amount_cents: args.amount_cents,
      client_id: args.client_id,
      created_at: new Date().toISOString(),
      completes_at: completesAt,
    });
    // Schedule the simulated webhook flip. We intentionally do NOT await —
    // the caller gets the redirect URL immediately.
    setTimeout(() => {
      const tx = mockTransactions.get(transactionId);
      if (tx && tx.status === "pending") tx.status = "completed";
    }, COMPLETION_DELAY_MS);
    return { redirect_url: redirectUrl, transaction_id: transactionId };
  }

  async checkStatus(transactionId: string): Promise<CheckStatusResult> {
    const tx = mockTransactions.get(transactionId);
    if (!tx) return { status: "pending" };
    return { status: tx.status, reference: tx.reference };
  }

  async health(): Promise<OzoneHealth> {
    return { status: "ok", mode: "mock", message: `${mockTransactions.size} mock transactions in flight` };
  }
}

export class LiveOzoneProvider implements OzoneProvider {
  name = "ozone" as const;

  private readonly apiUrl: string;

  private readonly apiKey: string;

  constructor() {
    this.apiUrl = (process.env.OZONE_API_URL ?? "").trim();
    this.apiKey = (process.env.OZONE_API_KEY ?? "").trim();
  }

  async initiateTopup(_args: InitiateTopupArgs): Promise<InitiateTopupResult> {
    // Not wired yet — blocked on Tsie + vendor contract. Return a recognisable
    // shape so the BFF can surface "unconfigured" via the UI badge
    // (`data-source="code-gap"`).
    throw new Error("Ozone live provider not yet configured (awaiting vendor contract)");
  }

  async checkStatus(_transaction_id: string): Promise<CheckStatusResult> {
    return { status: "pending" };
  }

  async health(): Promise<OzoneHealth> {
    if (!this.apiUrl || !this.apiKey) {
      return { status: "unconfigured", mode: "unconfigured", message: "OZONE_API_URL/KEY not set" };
    }
    return { status: "degraded", mode: "live", message: "Live transport not wired yet" };
  }
}

let cachedProvider: OzoneProvider | null = null;

/**
 * Selector. `OZONE_MODE=live` returns the LiveOzoneProvider; anything else
 * (including unset) returns the mock. The cache is process-local — tests
 * can call `resetOzoneProvider()` to force re-selection.
 */
export function getOzoneProvider(): OzoneProvider {
  if (cachedProvider) return cachedProvider;
  const mode = (process.env.OZONE_MODE ?? "mock").toLowerCase().trim();
  cachedProvider = mode === "live" ? new LiveOzoneProvider() : new MockOzoneProvider();
  return cachedProvider;
}

export function resetOzoneProvider(): void {
  cachedProvider = null;
}

/**
 * Reset the in-memory mock transaction map. Test-only — production code
 * never needs this since the worker is single-replica and the map is
 * short-lived (transactions complete in 5 s).
 */
export function resetOzoneMock(): void {
  mockTransactions.clear();
}

/**
 * Inline snapshot of the mock transaction map — used by tests + dev tooling
 * to inspect what the simulator has queued. Never expose to clients.
 */
export function debugOzoneMockSnapshot(): MockTransaction[] {
  return [...mockTransactions.values()];
}
