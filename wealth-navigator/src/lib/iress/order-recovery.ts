// `orderCreate3` recovery — given a transient transport failure (HTTP 500,
// timeout, TCP RST) on `OrderCreate3`, re-query IRESS via
// `OrderNoGetByOrderTag` to learn whether the broker accepted the tag.
//
// Per IRESS V4 quick reference (`iress-v4-docs/10-reference/quick-reference/00-master.md`),
// `OrderNoGetByOrderTag` is the documented lookup that resolves the broker
// `OrderNumber` for a given `OrderTag`. It's the idempotency contract the
// existing `orderCreate3` already documents in `OrderTag` mode.

import type { IressClient, OrderCreate3Request, OrderCreate3Response } from "@/lib/iress/client";

export interface OrderCreateWithRecoveryOptions {
  /** The typed IRESS client (live or mock). */
  client: IressClient;
  /** The exact request sent to `orderCreate3`. */
  request: OrderCreate3Request;
  /**
   * Delay before the recovery lookup. Default 1.5s — long enough for the
   * broker to commit the in-flight order on the IOS+ side, short enough
   * that a trader doesn't sit staring at a spinner. CT is single-seat so
   * we don't want to hammer the wire.
   */
  delayMs?: number;
  /** How many recovery attempts to make (default 1 — single recovery pass). */
  maxRecoveryAttempts?: number;
  /**
   * Test seam — override the sleep between attempts. Production callers
   * should leave it undefined.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface OrderCreateWithRecoveryResult {
  /** What the call ultimately returned. */
  response: OrderCreate3Response;
  /** True when the response came from the recovery path (not the original call). */
  recovered: boolean;
  /** True when the broker had already accepted the tag at recovery time. */
  brokerAcceptedOnRecovery: boolean;
}

/** Returns true for transport faults that may have left the order in flight. */
function isTransientTransportError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = Number((err as { code: unknown }).code);
    // 666 = SOAP fault / system error. 25019 = "server overloaded — back
    // off and retry". 25021 = "request in progress". None of these tell us
    // whether the broker accepted the order; the only safe path is to
    // re-query by tag.
    if (code === 666 || code === 25019 || code === 25021) return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("http 500") ||
    msg.includes("http 502") ||
    msg.includes("http 503") ||
    msg.includes("http 504")
  );
}

/**
 * Place an order via `orderCreate3` with a single recovery pass. On a
 * transport-level failure that may have left the order in flight, the helper
 * waits `delayMs` and then calls `orderNoGetByOrderTag` to ask IRESS
 * whether it accepted the tag. The returned `response` always carries a
 * real `OrderNumber`; the `recovered` flag tells the caller whether to log
 * the recovery for ops review.
 *
 * - When `orderCreate3` returns a clean `OrderCreate3Response` the first
 *   time, the call is a thin pass-through.
 * - When `orderCreate3` throws a transient transport error and the broker
 *   later resolves the tag, the helper synthesises a `WORKING` response
 *   with the broker's `OrderNumber`.
 * - When `orderCreate3` throws a transient transport error and the broker
 *   does not yet recognise the tag, the helper re-throws the original
 *   transport error so the UI surfaces a clear "could not place order"
 *   toast.
 * - When `orderCreate3` throws a non-transient `IressError` (e.g. 25010
 *   "method not entitled", 25032 "invalid account"), the helper
 *   re-throws immediately — recovery wouldn't change the answer.
 */
export async function orderCreate3WithRecovery(
  opts: OrderCreateWithRecoveryOptions,
): Promise<OrderCreateWithRecoveryResult> {
  const delayMs = opts.delayMs ?? 1500;
  const maxRecoveryAttempts = opts.maxRecoveryAttempts ?? 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRecoveryAttempts; attempt++) {
    try {
      const response = await opts.client.orderCreate3(opts.request);
      return { response, recovered: false, brokerAcceptedOnRecovery: false };
    } catch (err) {
      lastErr = err;
      if (!isTransientTransportError(err)) throw err;
      if (attempt >= maxRecoveryAttempts) break;
      // Wait, then ask IRESS whether the broker already accepted the tag.
      // A single recovery pass is enough — IRESS is single-seat and the
      // OEMS UI sits on a 1.5s spinner, not a long retry loop. If the
      // broker has the tag, return it; otherwise re-throw the original
      // transport error so the trader sees a clear failure.
      await sleep(delayMs);
      let lookup: { OrderNumber: string; OrderTag: string };
      try {
        lookup = await opts.client.orderNoGetByOrderTag({
          ServiceSessionKey: opts.request.ServiceSessionKey,
          OrderTag: opts.request.OrderTag,
        });
      } catch {
        // Recovery lookup itself failed (e.g. service session dead).
        // Don't recurse — re-throw the original transport error so the
        // trader sees a clear failure.
        throw err;
      }
      if (lookup.OrderNumber) {
        return {
          response: { OrderNumber: lookup.OrderNumber, Status: "WORKING" },
          recovered: true,
          brokerAcceptedOnRecovery: true,
        };
      }
      // Broker doesn't yet know the tag — treat as a hard failure for
      // this attempt, not a reason to retry `orderCreate3` again (that
      // would risk a duplicate on the broker side).
      throw err;
    }
  }
  throw lastErr;
}
