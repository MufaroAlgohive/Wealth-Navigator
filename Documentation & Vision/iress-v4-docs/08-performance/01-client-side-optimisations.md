# Client-Side Optimisations

Five concrete levers, in priority order.

## 1. Use the largest practical `PageSize`

> *"The more data a client app can receive per page means less overall requests. Each request has overheads, for example in terms of authentication and validation. By minimising the number of requests this can lead to better performance."*

- Default is 1000. Most methods accept up to that.
- For "Get"-style backfills, this is the single biggest win.
- Live updates: page size doesn't apply.

## 2. Use "bulking" where available

> *"If sending bulk data into the server and the method being used supports multiple input rows, send up to the maximum rows supported."*

- `OrderCreate3`, `IPSUploadDataSet1`, etc. support bulk input.
- Send in chunks of `n` rows per call, where `n` is the method's documented max.

## 3. Enable compression

> *"Ensure compression is enabled between both the client and server. While compression may consume a little more CPU on the web servers, it can result in a much faster transport time for requests, responses and updates."*

- Set HTTP header `Accept-Encoding: gzip` on every request.
- Confirm `Content-Encoding: gzip` on responses.
- In production: always on. In dev: leave on, it's free.

## 4. Network throughput

> *"Ensure network speeds are not a bottleneck. For example if all computers in the network are on 1gbps speeds, but the calling computer is on 100mbps, speed improvements can be obtained by upgrading the calling computer's network speed."*

- For the Mint OEMS, this is a deployment concern, not a code concern.
- Run the OEMS on a host with sufficient uplink.

## 5. Use a cut-down WSDL

> *"Use a 'cut-down' WSDL based on the method filter feature; where only the methods required by the application are returned in the WSDL."*

- Anecdote from the source PDF: **45s → <1s** for `IRESSSessionStart` after cutting the WSDL.
- Also improves IDE responsiveness (notably Visual Studio).

> See [`../01-foundations/03-endpoints.md`](../01-foundations/03-endpoints.md) for the recommended Mint WSDL cuts.

## Bonus: HTTP keep-alive

- Reuse TCP connections across calls. Most SOAP toolkits do this by default; verify in your HTTP client config.
- The IRESS servers support keep-alive; you should too.

## Bonus: in-process caching

- For data that doesn't change intra-day (security reference, fee schedule, destination metadata), cache aggressively.
- Don't re-fetch what you already have.

## Anti-patterns

- ❌ Calling `IRESSSessionStart` on every API call (use a long-lived session).
- ❌ Re-issuing the same data call from multiple threads (you'll hit the 50-active-requests cap).
- ❌ Polling updates on a wide filter and not narrowing when the queue fills.
- ❌ Bulk calls with one row per call ("bulk of size 1" defeats the purpose).
