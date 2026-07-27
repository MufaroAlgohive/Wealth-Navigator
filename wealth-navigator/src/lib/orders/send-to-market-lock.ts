/**
 * Kill-switch on "Send to Market".
 *
 * Added 2026-07-23 to stop any accidental release of parked mint client-orders
 * to the broker while production behaviour was still being verified.
 *
 * UNLOCKED 2026-07-27 on Juan's instruction, for the live IRESS order session.
 * UAT was completed against the CT endpoint and IRESS (Andre) confirmed the
 * production move is the same integration with `webservices` in place of
 * `webservices-ct` — the `LONGMARK CARE` destination is unchanged and routes to
 * LONGMARK as the executing broker.
 *
 * Parking was never affected by this flag; only release was. Releasing now runs
 * the full chain: a FRESH preflight against live balances at click time, then
 * the worker's production readiness gate, then the per-client pre-trade guard
 * (`IRESS_PER_CLIENT_GUARD`) which checks the order against THAT client's own
 * wallet and holdings rather than the desk omnibus.
 *
 * To re-lock — during an incident, a bad fill, or an IRESS outage — set this
 * back to `true` and deploy. It is enforced in two places so a locked button
 * cannot be bypassed by calling the API directly: the UI
 * (execution-view.tsx disables the button) and the server
 * (release-to-market/route.ts returns 423).
 *
 * This is the LAST purely-local stop before real client money moves. Treat a
 * change here as a trading decision, not a code change.
 */
export const SEND_TO_MARKET_LOCKED = false;
export const SEND_TO_MARKET_LOCKED_MESSAGE =
  "Send to Market is temporarily locked. It will be unlocked once today's production checks are complete.";
