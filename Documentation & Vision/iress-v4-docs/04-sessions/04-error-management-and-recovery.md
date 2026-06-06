# 04 — Session Error Management & Recovery

Iress sessions and service sessions can end for many reasons — most are detected by the client as **error codes** in subsequent calls. This page is the canonical "what to do when you see X" reference.

## Session hierarchy reminder

- An **Iress session** is always the **parent**.
- A **service session** (IOS+, IPS, FIX+) is always a **child** of an Iress session.
- Ending the parent ends the children.

```
IRESSSession (parent)
├── ServiceSession (IOS+)    (child)
├── ServiceSession (IPS)     (child)
└── ServiceSession (FIX+)    (child)
```

## The error codes that mean "your session died"

| Error | Meaning | What to do |
|---|---|---|
| `25006` | Service session in the request is no longer valid. | Create a new service session and retry. **Don't end the existing service session yet — other requests may still be in flight against it.** |
| `25009` | Invalid service session key. | Same as 25006. Verify the key is in the request and wasn't previously ended. |
| `25014` | Invalid Iress session key. | Create a new Iress session (which will require new service sessions). |
| `25019` | Invalid Iress or service session key. | Same as above — context-dependent. Check which key you sent. |
| `25022` | Request cannot be made because user is not logged in. | Iress session ended mid-request. Create a new Iress session. |
| `25033` | Service session was terminated. | The error message usually includes the reason (e.g. IOS+ group access changed). Create a new service session. |

The full table is at [`../06-errors/01-session-error-codes.md`](../06-errors/01-session-error-codes.md).

## Best-practice workflow

```
   ┌────────────────────────┐
1. │ IRESSSessionStart       │  ApplicationID = unique GUID
   └─────────────┬──────────┘
                 ▼
   ┌────────────────────────┐
2. │ ServiceSessionStart     │  e.g. Service = "IOSPlus"
   └─────────────┬──────────┘
                 ▼
   ┌────────────────────────┐
3. │ data calls              │  using ServiceSessionKey
   └─────────────┬──────────┘
                 ▼
        either   or
   ┌─────────────┘   └─────────────┐
   ▼                                ▼
4a. service session ends         4b. Iress session ends
   → errors 25006/25009/            → errors 25014/25019/25022
     25019/25033                      (or also 25006/25009/25033
   → rebuild service                  if children re-used)
     session, retry                → rebuild Iress session
                                       (and child service sessions)
```

## Recovery — concrete recipes

### Recipe A: "I got 25006 on a service call"

```
1. Try the call once more on the same service session key.
   - Sometimes a transient hiccup; server has already recovered.
2. If it fails again:
   a. Issue ServiceSessionStart on the still-valid Iress session.
   b. Swap the new ServiceSessionKey into the client.
   c. Retry the original call.
3. If ServiceSessionStart itself fails with 25014/25019/25022:
   → go to Recipe B.
```

### Recipe B: "I got 25014 on any call"

```
1. Issue IRESSSessionStart with the same UserName + CompanyName + ApplicationID.
   - If a backend session exists with these credentials, the same key is returned.
   - If not, a new one is created.
2. Re-issue ServiceSessionStart for each service you need.
3. Retry the original call.
```

### Recipe C: "I lost the IressSessionKey and need to recover"

```
1. Re-issue IRESSSessionStart with the same UserName + CompanyName + ApplicationID.
   - The server returns the existing key if a backend session exists.
2. If you don't remember the ApplicationID:
   - Generate a new one; this creates a new session and consumes a new license.
3. If you get 25008 (out of licenses), see [User Scenarios](03-user-scenarios.md).
```

### Recipe D: "I got a timeout on `IRESSSessionStart`"

```
- The backend may still have created the session even though the client never got the response.
- Re-issue with the same UserName + CompanyName + ApplicationID.
- The same key is returned.
```

### Recipe E: "Network dropped, I lost connectivity, then came back"

```
- The Iress session may still be alive on the server (it doesn't time out due to client network drops — only inactivity on the server side).
- Re-issue IRESSSessionEnd with the old key to release the license cleanly.
- Or just let it expire (2h).
- Open a new Iress session when needed.
```

## Service session died: server-side reasons

The `25033` error message often includes the reason. Common reasons:

- **Permission changes** — admin revoked a permission for the user.
- **Group access change** — user moved between groups.
- **Server (e.g. IOS+) went offline** — planned or unplanned outage.
- **Service idle time limit** — typically inherited from parent Iress session.

## Don't reuse keys across rebuilds

> Once you decide to end a service session (or one dies), **do not keep using the old key**. It will keep returning 25006/25009/25019/25033. Replace it everywhere it's stored.

## Mint OEMS — recommended session state machine

```ts
type IressSessionState =
  | { kind: 'none' }
  | { kind: 'starting'; applicationId: string; startedAt: Date }
  | { kind: 'active'; applicationId: string; key: string; startedAt: Date; lastActivityAt: Date }
  | { kind: 'expired'; applicationId: string; key: string; expiredAt: Date }
  | { kind: 'failed'; applicationId: string; error: number; message: string };

type ServiceSessionState =
  | { kind: 'none' }
  | { kind: 'starting' }
  | { kind: 'active'; key: string; lastActivityAt: Date }
  | { kind: 'expired'; key: string; expiredAt: Date }
  | { kind: 'failed'; error: number; message: string };
```

A single supervisor watches all sessions:

- Re-issues `IRESSSessionStart` on 25014/25019/25022 or proactive idle.
- Re-issues `ServiceSessionStart` on 25006/25009/25019/25033.
- Propagates the new key to all in-flight callers transparently (lock-free, atomic swap).
- All callers re-issue the call on the new key; idempotent for "Get" methods; requires idempotency key for "Set" methods (see [`../07-recovery/05-iosplus-order-creation-recovery.md`](../07-recovery/05-iosplus-order-creation-recovery.md)).
