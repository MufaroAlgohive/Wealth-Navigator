# 03 — Updates (Long Polling)

Some V4 methods support **live updates** to their data — quotes, orders, executions, transactions. Updates are delivered over a **long-polling** mechanism.

## How it works

1. Call the **data method** with `Updates = true` in the header.
2. The server returns the snapshot (possibly paged) and eventually sets `StatusCode = 3` (watching).
3. Switch to calling the matching **`*Updates` method** with the **same `RequestID`**, continuously.
4. Each call to the updates method **long-polls** the server: the HTTP connection is held open until either data is available or the **NoUpdateBlockTime** (default 1000s) elapses.
5. The subscription ends when **any** of the following happens:
   - The request sits idle for **30 minutes** (`RequestExpiryTime`).
   - The queued updates exceed the **10 000-row** limit.
   - You explicitly call `SessionRequestEnd(RequestID=…)`.
   - You end the session.

## Identifying updates-supporting methods

The method reference shows:

- `Supports Updates: true`
- `Updates Method: <MethodName>Updates` (e.g. `PricingQuoteGetUpdates`, `OrderPadGetByAccountUpdates`)

The naming convention is consistent: every base method that supports updates has a `…Updates` counterpart that takes the same `RequestID`.

## Two ways to subscribe

1. **Snapshot + updates on the same request** — e.g. `OrderPadGetByAccount` with `Updates=true`. The snapshot is delivered first, then updates flow through the matching `OrderPadGetByAccountUpdates`.
2. **Updates only** — call the data method, discard the snapshot, and only use the `*Updates` method. Common for tickers (e.g. `PricingQuoteGet` then `PricingQuoteGetUpdates` for a trade ticker).

## Update filter inheritance

> The data method's filter set is typically **larger** than what the matching `*Updates` method can re-filter on. **Apply additional filtering client-side** on the update stream. The server will deliver updates that match the data method's filter; client-side is responsible for narrowing further.

## Two patterns for snapshot+updates

| Pattern | When to use |
|---|---|
| **Watch first, snapshot second** (recommended) | Always when reconciliation matters. Server buffers updates between the watch start and the snapshot delivery, then replays them in order. |
| **Snapshot first, watch second** | Useful when you don't need replay ordering and want the UI to render immediately. |

The IRESS docs prefer pattern 1 for recovery scenarios — see [`../07-recovery/04-iosplus-order-retrieval-recovery.md`](../07-recovery/04-iosplus-order-retrieval-recovery.md).

## Quota management

- **Update queue limit per request:** 10 000 rows. If you don't poll fast enough, the queue fills and the request is **forcibly ended** with error 25007.
- **Mitigation:**
  - Poll more frequently.
  - If you can't poll faster, **narrow the filter** to a smaller set (e.g. one account per `OrderPadGetByAccount` rather than an `AccountGroup` with 1 000 accounts).
  - **Don't poll in parallel** against the same `RequestID` — the server holds the connection, and parallel calls will just stack. One polling thread per `RequestID`.

## Long-poll loop

```pseudo
function watch(methodCall, updatesCall, requestId):
    # 1) initial snapshot
    response = methodCall(RequestID = requestId, Updates = true)
    processRows(response.Result.DataRows)
    while response.Result.Header.StatusCode != 3:
        response = methodCall(RequestID = requestId)   # keep paging
        processRows(response.Result.DataRows)
    # 2) updates loop
    while True:
        try:
            response = updatesCall(RequestID = requestId)   # long-poll
            processRows(response.Result.DataRows)
        except SoapFault as f:
            if f.Number == 25007:                  # queue full
                # restart with a narrower filter
                break
            if f.Number == 25028:                  # request expired
                # re-issue from scratch
                break
            raise
```

## Lifecycle summary

```
            ┌──────────────────────────┐
            │  IRESSSessionStart       │
            └─────────────┬────────────┘
                          ▼
            ┌──────────────────────────┐
            │  Data method (Updates=   │
            │  true, RequestID=R1)     │
            └─────────────┬────────────┘
                          ▼
       ┌─────────── status=1 (paging) ───────────┐
       │                                         │
       ▼                                         ▼
   re-call same R1                          status=3
       │                                  (watching)
       ▼                                         │
   re-call same R1                              ▼
       │                            ┌────────────────────────┐
       ▼                            │  *Updates method       │
   status=2 (finished)              │  (RequestID=R1)        │
                                    └────────────┬───────────┘
                                                 ▼
                                       long-poll loop until
                                       expiry / explicit end
                                                 ▼
                                    ┌────────────────────────┐
                                    │  SessionRequestEnd(R1) │
                                    └────────────────────────┘
```
