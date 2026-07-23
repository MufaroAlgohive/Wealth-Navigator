/**
 * Temporary kill-switch on "Send to Market" (2026-07-23), requested to stop
 * any accidental release of parked mint client-orders to the broker while
 * production behavior is still being verified. Parking itself is untouched
 * — orders still park and show on the order book normally, they just can't
 * be released from here. Flip SEND_TO_MARKET_LOCKED to false to unlock.
 *
 * Enforced in two places so a locked button can't be bypassed by calling
 * the API directly: the UI (execution-view.tsx disables the button) and
 * the server (release-to-market/route.ts returns 423 if locked).
 */
export const SEND_TO_MARKET_LOCKED = true;
export const SEND_TO_MARKET_LOCKED_MESSAGE =
  "Send to Market is temporarily locked. It will be unlocked once today's production checks are complete.";
