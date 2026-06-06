# Session Error Codes

> The source PDF: *"Note, this list is not exhaustive and new errors may be added over time. In addition, there may be some changes to error descriptions so it is not recommended to do exact string matches."*

Always match on the **error number**, not the description string.

## Quick reference

| Code | Description | Code action | Investigation |
|---|---|---|---|
| `0` | Login failed, awaiting login response | Retry with a new `RequestID`. | No action; possibly a slowness on the server. |
| `25001` | No `RequestID` was specified in the SOAP request | Generate a new unique `RequestID` and retry. | Make sure a non-empty `RequestID` string is always specified in all SOAP requests. |
| `25002` | The specified `RequestID` was not found on the server | Can be ignored. | When ending a request with `SessionRequestEnd`, make sure to specify a valid existing `RequestID`. |
| `25003` | The request with the specified `RequestID` has already ended | Can be ignored. | Once a request has ended, do not attempt to end it again. |
| `25004` | The request failed to be parsed correctly | Fail gracefully; no recovery. | Make sure the request is valid (method name is valid, elements are valid, etc.). |
| `25006` | The service session referenced in the request is no longer valid | Create a new service session and retry. | Do not end the service session when further requests are still going to be called against it. This error can also occur if the server (e.g. IOS+) goes offline and the service sessions against the server are invalidated, or if an IOS+ group access setting changed. |
| `25007` | Maximum number of queued update rows has been reached (default 10 000 rows); the request has been forcibly ended | Retry with a new `RequestID`. | Make sure to retrieve updates as fast as possible to avoid filling up the server-side cache. |
| `25008` | Server error (currently used for login failures) | Fail gracefully; no recovery. | Check login details in the request and that the user has appropriate permissions. |
| `25009` | Invalid service session key specified | Create a new service session and retry. | Check that the `ServiceSessionKey` is correct and that the service session was not previously ended. |
| `25010` | The bookmarks specified in the request failed to parse | Fail gracefully. | Check the bookmarks (types correct, values within valid ranges). |
| `25011` | Not allowed to create multiple service sessions to the same server | Retry with a new `RequestID`. | No action; inform your Iress Account Executive or support desk. |
| `25012` | Invalid server name specified | Fail gracefully. | Check that the server name specified is valid. |
| `25013` | No session key was provided in request | Create a new Iress session. | Check that all SOAP requests contain a valid session key. |
| `25014` | Invalid session key specified | Create a new Iress session. | Check that the session key specified in the SOAP request is valid. |
| `25015` | Internal error, server is offline | Retry with a new `RequestID`. | Inform your Iress Account Executive or support desk. |
| `25016` | Maximum number of active sessions reached (default 20 000 sessions) | Fail gracefully. | Reduce the total number of sessions used; or, once the limit is reached, end some existing Iress sessions before attempting to start new ones. |
| `25017` | Internal session allocation error | Fail gracefully. | Inform your Iress Account Executive or support desk. |
| `25018` | Impersonation is not allowed on this WebServices instance | Fail gracefully. | Do not specify an `IRESSSessionKey` in the header of the `IRESSSessionStart` request. |
| `25019` | Invalid `IRESSSessionKey` or service session key specified | Create a new Iress session or service session. | Check the keys are valid. Can also occur if the server (e.g. IOS+) goes offline and the service sessions against the server are invalidated, or if an IOS+ group access setting changed. |
| `25020` | Login failed | Fail gracefully. | Check login details and that the user has the appropriate permissions. |
| `25021` | Internal error, request is in use | Retry with a new `RequestID`. | Inform your Iress Account Executive or support desk. |
| `25022` | Request cannot be made because user is not logged in | Create a new Iress session and retry. | The Iress session ended when a new request against that session was made. Either create a new Iress session before making the request, or ensure the Iress session is not ended when the request is made. |
| `25023` | Internal error, `RequestID` not found | Retry with a new `RequestID`. | Inform your Iress Account Executive or support desk. |
| `25024` | The specified `RequestID` was for a different request type | Retry with a new `RequestID`. | Check that `RequestID`s of active requests are not being reused for any other requests. |
| `25025` | The request is no longer watching for updates | Retry with a new `RequestID`. | Check that a `RequestID` that has been ended is not being used again to retrieve update data. |
| `25026` | Maximum number of active requests for the session has been reached | Fail gracefully. | End any active requests in the session before making new requests. |
| `25027` | The request with the specified `RequestID` has already finished | Retry with a new `RequestID`. | Do not reuse a `RequestID` that was previously used. |
| `25028` | The request with the specified `RequestID` has expired | Retry with a new `RequestID`. | An idle request (e.g. a request watching updates but never retrieving the update data) will expire after a period (default 30 min). Keep the request active to avoid expiration. |
| `25031` | The request was terminated because of a session logout request | Fail gracefully or create a new Iress session and retry. | Make sure that the session is not ended while a request is still in progress. |
| `25032` | The request timed out while waiting for a response from the server | Action depends on the type of request. Read-only: retry with a new `RequestID`. Mutating: check the state of the data first. | n/a |
| `25033` | The service session was terminated | Create a new service session and retry. | The error message contains the reason for termination (e.g. IOS+ group access changed) which may provide guidance. |
| `25035` | The server is offline | Create a new service session and retry. | Inform your Iress Account Executive or support desk. |
| `666` | Invalid session key specified, invalid SOAP request (e.g. XML contains invalid elements) | Fail gracefully. | Inform your Iress Account Executive or support desk. |
| `666` | Could not communicate with data server | Create a new Iress session and retry. | Inform your Iress Account Executive or support desk. It is possible that this was a scheduled outage (e.g. software upgrade). |
| `666` | Could not located IDS for this request | Create a new Iress session and retry. | Inform your Iress Account Executive or support desk. It is possible that this was an outage or session key mixup. E.g. the request passing a session key with `…@IDSA32` but there is no such IDS on the cluster. |

## See also

- [`../04-sessions/04-error-management-and-recovery.md`](../04-sessions/04-error-management-and-recovery.md) — recovery patterns.
- [`02-application-error-management.md`](02-application-error-management.md) — application-level (per-row) errors.
- [`03-faq.md`](03-faq.md) — common questions.
- [`04-support-queries.md`](04-support-queries.md) — what to send IRESS when raising a ticket.
