# 05 — Session Expiration

Sessions don't live forever. The Iress server enforces **three** independent limits; the session dies as soon as **any** of them is hit.

## The three limits

| Limit | Default | Source | Notes |
|---|---|---|---|
| **Idle timeout** | 2 hours | Server-side (per group) | Resets on every request through the session. |
| **Absolute lifetime** | 24 hours | `SessionTimeout` param (max 1440 min) | From session creation. |
| **Group expiry** | 1:00 AM server time (default) | Web Admin: User group / company level | Can be a fixed time, or a duration. |

> The default group expiry of 1:00 AM is **server timezone**. For the South Africa production environment, that's likely **SAST (UTC+2)**. If your trading day is on the wrong side of midnight SAST, a session can expire mid-shift.

## Overriding per call

`IRESSSessionStart` accepts a `SessionTimeout` parameter (int, minutes, max `1440`) that overrides the group-level default for that session. The actual expiration may fire **up to 1 minute** after the requested value.

```xml
<v4:SessionTimeout>120</v4:SessionTimeout>   <!-- 2 hours -->
```

Use this to:

- Align expiry with your OEMS process lifecycle (e.g. `SessionTimeout = 60` for a UI session that auto-locks after 60 min).
- Avoid the group-level 1:00 AM cliff by requesting a session that's already past that point (e.g. create at 00:30 with `SessionTimeout = 60` and the session will die at 01:30, not 01:00).

## Don't try to "extend" a session

There is no `IRESSSessionExtend` method. To extend a session, **end it and re-create**. Re-creating with the same `ApplicationID + UserName + CompanyName` reuses the same login slot, but a new session token is issued.

## Detecting expiration

- You **won't get a notification** — the next call simply fails.
- The error code depends on which session expired:
  - Iress session expired → `25014` (or `25019`/`25022` if the call is also bad).
  - Service session expired → `25006`/`25009`/`25019`/`25033`.

## Mint OEMS recommendations

- For a 24/7 OEMS: use `SessionTimeout = 1440` (24h) and refresh **proactively** every 23h.
- For a UI session: use `SessionTimeout = 60` and refresh on user activity, or just let it expire.
- **Don't use 1:00 AM SAST sessions for after-hours jobs** unless you really want them dying at 1 AM. Set a higher `SessionTimeout` or schedule the job to start after 1 AM.
- **Track `lastActivityAt`** on the Iress session object in your code. A background timer can warn you at e.g. 1h45 of idle ("session will expire in 15 min — refresh?").
