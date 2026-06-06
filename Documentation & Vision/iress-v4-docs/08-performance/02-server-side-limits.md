# Server-Side Limits

Default values, configurable per web server for clients with their own local deployment.

| Limit | Default | Description |
|---|---|---|
| **Max Page Size** | 1000 | Maximum rows in a page returned to the client if the server does not specify for the method. |
| **No update block time** | 1000 (seconds) | How long the server blocks waiting for updates to arrive before returning an empty response to the client. |
| **Request expiry time** | 1800 (seconds, 30 min) | How long an idle request (not being interacted with by the client) remains active before expiring. |
| **Request time out** | 25 (seconds) | Request timeout if the client specified no timeout. |
| **Login Timeout** | 60 (seconds) | Session login timeout. |
| **Max requests per session** | 50 | Maximum active requests per `IRESSSessionKey`. |
| **Session expiry time** | 7200 (seconds, 2 hours) | How long an idle session remains active before expiring. |
| **Max active sessions on server** | 20 000 | Maximum number of `IRESSSessionKey`s that can be alive at once. |
| **Update queue limit per request** | 10 000 | Maximum queued update rows per `RequestID`. |
| **Iress session absolute lifetime** | 24 hours | Hard cap on session age. |
| **Group-level session expiry** | 01:00 server time (configurable) | Wall-clock daily expiry. Configurable to a fixed time or a duration. |

> Source PDF: *"These limits are in place to ensure optimal performance of the server for all users, by minimising the impact that a single user can have on resources on the server."*

## How to behave under each

### Max Page Size (1000)

- Don't ask for more. The server will cap it.
- If you get fewer rows than requested, the method has a smaller per-method cap. Don't assume the cap.

### No update block time (1000s)

- The server holds the connection up to this long waiting for an update.
- If no update arrives, the response is **empty** with `StatusCode=3`.
- This is intentional — don't treat empty responses as errors.

### Request expiry time (1800s / 30 min)

- If you don't poll updates for 30 minutes, the request is forcibly ended.
- Poll at least every ~25 min to stay safe.

### Request timeout (25s)

- The data server has this long to respond. After that, you get a timeout error.
- For methods known to be slow (uploads, large queries), set a higher `Timeout` in the header.

### Login timeout (60s)

- `IRESSSessionStart` will wait up to 60s before giving up.
- The PDF calls out that `IRESSSessionStart` has a 55s default `Timeout` — keep it near 55s.

### Max requests per session (50)

- If you hit this, you'll get `25026`.
- Spread work across multiple Iress sessions, or make calls more sequential.
- See [`../06-errors/03-faq.md`](../06-errors/03-faq.md).

### Session expiry (2h idle)

- A session with no activity for 2h is expired by the server.
- Refresh proactively if you expect a long idle window.

### Max active sessions (20 000)

- The whole server's session pool. If you hit it, `25016` is returned.
- Coordinate with your IRESS account exec; this is rarely a single-tenant limit.

### Update queue limit (10 000)

- If you don't poll fast enough, the queue fills and the request is forcibly ended with `25007`.
- See [`../06-errors/03-faq.md`](../06-errors/03-faq.md).

### Session absolute lifetime (24h)

- Even if active, the session dies at 24h.
- Re-create well before this limit.

### Group-level session expiry (01:00 default)

- Sessions die at 01:00 server time, regardless of activity.
- Plan around it. For a 24/7 OEMS, set `SessionTimeout` strategically.

## See also

- [`../04-sessions/05-session-expiration.md`](../04-sessions/05-session-expiration.md) — session-level details.
- [`../06-errors/01-session-error-codes.md`](../06-errors/01-session-error-codes.md) — the error codes.
