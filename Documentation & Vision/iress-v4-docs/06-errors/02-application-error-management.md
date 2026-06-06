# Application Error Management

This is error handling **outside of session-level errors** — the kind that happens at the method call level. Some exceptions are raised **client-side** (in the calling application), some are **server-side** (returned by Iress).

## Three error categories

### 1. System errors

Generally returned as **SOAP faults** (HTTP 500). Examples:

- Server has gone offline.
- The requesting user doesn't have the right permissions for the method.
- The call timed out server-side.

The fault can originate at two layers:

- **Web server layer** — request timed out waiting for the data server.
  > "Request 'AuditTrailGetByUser' with ID '383fe5c4-…' has timed out while waiting for a response from server."

- **Iress application layer** — the underlying Iress system timed out.
  > "SQL request failed. Operation canceled? on RequestID 90C324C7-… from AdminUserCreate transaction invoked at 2011/05/02 15:39:56"

  > "Database timeout occurred." / "Could not load data from database."

### 2. Data errors

These are per-row errors on **"set"** methods (create, amend, delete) — especially methods that support bulk input. They're returned **in the response**, not as a fault. Inspect:

- `ErrorNumber` — non-zero indicates an error.
- `ErrorMessage` / `ErrorDescription` — non-empty indicates an error.
- `ErrorRows[]` — explicit collection on some methods.

Some methods expose both `ErrorNumber` and `ErrorMessage`/`ErrorDescription`; others expose only one. Always check both when present.

### 3. Client-side errors

These originate in the **calling application**. Example:

> "The request channel timed out while waiting for a reply after 00:01:00. Increase the timeout value passed to the call to Request or increase the SendTimeout value on the Binding. The time allotted to this operation may have been a portion of a longer timeout."

The HTTP client library (e.g. .NET WCF, Java CXF, Node strong-soap) raised the timeout, not Iress.

## How to handle

> *"The way in which timeouts and errors need to be handled depends on the requirements of the calling client application; for example, in a GUI based application it may be preferable to show an error message to the end user so they can chose how to react; in the case of a batch or scheduled process, it may be preferable to implement a retry system with a wait mechanism in order to be as resilient as possible and ideally requiring no human interaction."*

| App type | Strategy |
|---|---|
| GUI / user-facing | Show the error; let the user retry / cancel. |
| Batch / scheduled | Retry with backoff; alert on persistent failure. |
| OMS / order entry | "Get" methods → safe to retry. "Set" methods → check data state first, then idempotently retry. See [`../07-recovery/`](../07-recovery/). |

## String matching: don't

> *"Error descriptions may change and it is recommended to avoid doing exact string matches to identify specific errors. Where possible, use the error number instead of an error message as typically the error number will not change."*

```ts
// ❌ bad
if (fault.Message.includes("Login failed")) { ... }

// ✅ good
if (fault.Number === 25020) { ... }
```

## See also

- [`01-session-error-codes.md`](01-session-error-codes.md) — session-level errors.
- [`../07-recovery/01-application-recovery.md`](../07-recovery/01-application-recovery.md) — how to recover.
