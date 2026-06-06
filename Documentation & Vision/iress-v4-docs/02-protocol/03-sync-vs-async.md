# 03 — Synchronous vs Asynchronous Calling

By default every V4 method call is **synchronous** — your HTTP connection blocks until the response is ready. The `WaitForResponse` header field controls this.

## Default behaviour (`WaitForResponse = true`)

```
client                                 server
──────                                 ──────
│  request (WaitForResponse=true)            │
│ ─────────────────────────────────────────► │
│  … waiting for the data server …           │
│  ◄─────────────────────────────────────────│
│  full response (or fault)                  │
```

The method call blocks for up to `Timeout` seconds (default 25, special case 55 for `IRESSSessionStart`).

## Async behaviour (`WaitForResponse = false`)

```
client                                 server
──────                                 ──────
│  request (WaitForResponse=false)           │
│ ─────────────────────────────────────────► │
│ ◄─────────────────────────────────────────│
│  empty response, StatusCode=1              │
│                                            │
│  re-call (same RequestID)                  │
│ ─────────────────────────────────────────► │
│  ◄── if data not ready: empty, status=1 ──│
│  ◄── if data ready: full response ────────│
```

When the server receives a `WaitForResponse=false` request, it returns **immediately** with `StatusCode=1`. You must keep calling the same method with the same `RequestID` until the server returns data (or a `StatusCode=2`/3 with a real body).

> The pattern is identical to a paging loop. Most clients implement a single `pollUntilDone()` helper that loops until `StatusCode != 1` and a real `DataRows` body arrives.

## When to use async

| Use case | Sync or async? | Why |
|---|---|---|
| UI "load" button | sync | Simplest mental model; one HTTP call. |
| Bulk backfill at startup | sync, large PageSize | Fewer round-trips; no need to interleave. |
| Background worker / queue | sync with long Timeout | Easier to reason about; no polling loop. |
| Server-side job that does many sequential calls | async | Frees the HTTP connection between polls, allowing other requests. |
| Streaming data (live updates) | n/a — use `Updates=true` and long-poll the `*Updates` method. | See [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md). |

## Mint OEMS recommendation

- For the **OMS UI** — keep `WaitForResponse=true` everywhere except order placement, where an async pattern lets you show "submitting…" without holding the user's tab hostage. A typical pattern:

  1. Submit order with `WaitForResponse=false`, `RequestID=R1`.
  2. UI shows "Submitting…" and a separate `OrderPadGetByAccountUpdates` watcher picks up the working state.
  3. When the order appears in the updates stream with state = `WORKING`, the UI shows "Working".
  4. Eventually state = `FILLED` or `CANCELLED` — UI updates and frees the user.

- For **scheduled batch jobs** (EOD reconciliation, position pull) — prefer `WaitForResponse=true` with a generous `Timeout` (e.g. 55s). Cleaner code, fewer transient states to handle.

## Anti-patterns to avoid

- ❌ Issuing an async call and **not** polling back. The server still holds the request; you'll burn one of the 50 active-request slots until expiry (30 min).
- ❌ Using async because "I want it faster". The data still has to be fetched from the Phoenix data server; async just hides the wait.
- ❌ Mixing `RequestID`s across many async calls without tracking them. You'll quickly hit the 50-active-request cap and start receiving 25026 errors.
