# FAQ

## Request has exceeded the maximum of 10 000 queued updates

The web server has a limit of **10 000 queued updates per `RequestID`**. Reaching it means the calling application is **not polling updates frequently enough**.

**Mitigations:**

1. **Poll more frequently.** If you're already at your polling ceiling, this isn't an option.
2. **Narrow the filter.** Example: when watching orders for a list of accounts via `OrderPadGetByAccountGroupUpdates`, instead of one request with a large account group, **split it into smaller groups** with one request per group. Each smaller subscription stays well under the queue limit.

> Don't `poll-and-keep-alive` the same `RequestID` from multiple threads — the server holds the connection, and concurrent calls just stack.

## The session has reached the limit of 50 active requests. You cannot create any more requests

Three checks:

1. **Drain in-flight data.** For every request, poll until `StatusCode != 1` (no more pages). Same for async calls. The request needs to fully finish (or be `SessionRequestEnd`-ed) for the slot to free up.
2. **Cancel early if you don't need the rest.** Call `SessionRequestEnd` with the specific `RequestID` if you only wanted the first page.
3. **Distribute the load.** If you have many methods running concurrently (e.g. a buy-side client hitting many sell-side IOS+ servers through one `IRESSSessionKey`), split the work across multiple Iress sessions, or make the calls more sequential.

## Do you support compression?

**Yes.** HTTP gzip is supported.

- Set the HTTP header `Accept-Encoding: gzip` on every request.
- If the server negotiates compression, the response will include `Content-Encoding: gzip`.
- Consult your development toolkit on how to set the header (e.g. .NET `HttpClient`, Java `HttpURLConnection`, Node `axios`).

> Compression is essentially free at the client and dramatically reduces transport time for the larger payloads (bookings, order pads, full IPS position lists). **Always enable in production.**

## See also

- [`01-session-error-codes.md`](01-session-error-codes.md)
- [`../08-performance/02-server-side-limits.md`](../08-performance/02-server-side-limits.md)
- [`../08-performance/01-client-side-optimisations.md`](../08-performance/01-client-side-optimisations.md)
