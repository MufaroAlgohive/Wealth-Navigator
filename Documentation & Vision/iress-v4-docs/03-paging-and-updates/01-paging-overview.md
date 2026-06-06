# 01 — Paging Overview

V4 supports **server-side paging** so that large result sets can be retrieved in smaller chunks. Paging is opt-in per request and is controlled by two header fields:

| Header | Default | Meaning |
|---|---|---|
| `PageSize` | `1000` | Max rows the server should return per page. The data server may impose a smaller limit per method. |
| `PagingBookmark` | empty | Opaque cursor returned in the previous response. Pass it back in the next call. |
| `PagingDirection` | `0` (forward) | Backward paging is documented but **not implemented** in V4. |

## Server-side rules

- The server returns at most `min(PageSize, serverMaxForThisMethod)` rows.
- If a response indicates `StatusCode = 1` (more data), call the same method again with the **same `RequestID`** to fetch the next page. The server returns a new `PagingBookmark` in each response.
- Continue until `StatusCode = 2` (finished) or `StatusCode = 3` (watching for updates — paging is done; switch to the `*Updates` method).

## Don't assume fixed page size

> The number of rows per page may be tuned server-side per method without notice. Don't hardcode "the page will always be 1000 rows" — always check `StatusCode`.

## Generic client loop

```pseudo
function fetchAllPages(methodCall):
    rows = []
    while True:
        response = methodCall(RequestID = same)
        if response.Result is None:
            break
        rows.extend(response.Result.DataRows or [])
        if response.Result.Header.StatusCode == 1:
            continue                    # fetch next page
        if response.Result.Header.StatusCode == 2:
            break                       # finished
        if response.Result.Header.StatusCode == 3:
            switchToUpdates(RequestID)  # watching
            break
    return rows
```

## Page size guidance

- **Backfill jobs**: use the largest `PageSize` the method allows (often 1000). Fewer HTTP round-trips.
- **Live updates tail**: paging is irrelevant; you'll be calling the `*Updates` method.
- **Realtime order pad**: `PageSize=0` (use the default — server picks) is fine; the snapshot is small relative to the update stream.

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| `StatusCode = 1` keeps coming back with empty `DataRows` | You're at end of data but in a race with the data server. | Treat as terminator; break the loop. |
| `PagingBookmark` parsing errors (25010) | You reused a bookmark from a different request or method. | Don't. Each `RequestID` has its own bookmark cursor. |
| Server returns fewer rows than `PageSize` even mid-result-set | Method has a smaller server-side cap. | Don't assume; keep paging on `StatusCode = 1`. |
