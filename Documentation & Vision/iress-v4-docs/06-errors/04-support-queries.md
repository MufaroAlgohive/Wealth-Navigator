# Support Queries — What to Send IRESS

When raising a support query with Iress, include as much of the following as possible. **The more you send, the faster the resolution.**

1. **Error message received from Iress** — with the message, Iress can quickly determine the source and the actions needed to resolve.
2. **Name of method called** — knowing the method lets Iress direct the query to the right team.
3. **Date and time the incident occurred** — accurate timestamp narrows the investigation window.
4. **`RequestID`** — with a unique `RequestID`, Iress can reconcile the path of the request through the backend.
5. **`IRESSSessionKey` and/or `ServiceSessionKey`** — allows Iress to investigate session state (logged in/out, active requests).
6. **`Username@company`** — lets Iress check permissions and the sessions the user is logged into.
7. **Service** (e.g. `IPS`, `IOS+`, `Iress`) — directs the query to the right team.
8. **Instance name** (IPS name, IOS+ name) — narrows the scope to the server in question.
9. **Request details (input parameters)** — lets Iress determine whether the request had valid parameters.
10. **WebServices endpoint used** — narrows the scope to the servers servicing that endpoint.

## Sanitising before sending

- **Don't** send the user's password. If you must include the request, redact `Password`.
- **Don't** send other users' session keys. Only the failing session key is needed.
- **Do** include the full `<IRESSFaultDetail>` block (or at least the `Number`, `Message`, `Service`, `Server`, `WebServiceTimeStamp`, `WebServiceServer`, `WebServiceConnection`, `RequestID`).
- **Do** include a one-line description of what you were trying to do (e.g. "place a market order on SHP for MINT-LIVE-001 via the test environment").

## Mint OEMS — log capture

Build the support bundle automatically. On any SOAP fault:

1. Log the full `<IRESSFaultDetail>`.
2. Log the full request envelope (with `Password` redacted).
3. Log the current `IRESSSessionKey` (or its hash — see below) and the active `ServiceSessionKey`.
4. Log the user, account, and method.
5. Log the `WebServiceTimeStamp` from the response.
6. Snapshot the application version and the WSDL version it was built against.

> Consider hashing session keys before logging (e.g. SHA-256 of the key). The hash is enough for IRESS to identify the session in their logs, but the raw key never leaves your system.

## See also

- [`01-session-error-codes.md`](01-session-error-codes.md)
- [`../07-recovery/`](../07-recovery/) — for self-recovery before you escalate.
