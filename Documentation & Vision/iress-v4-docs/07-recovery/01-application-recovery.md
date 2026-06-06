# Application Recovery

> Recovery from session-level errors is documented in [`../04-sessions/04-error-management-and-recovery.md`](../04-sessions/04-error-management-and-recovery.md). This page covers recovery for **specific methods** (especially timeouts and errors on individual calls).

## Two classes of methods, two recovery styles

### "Get" methods (read-only)

General principle: **re-issue a new request** once a new session has been established.

- If the method supports paging **with bookmarks**, you can **recover from the last data record retrieved** instead of restarting the whole request. Saves time on large backfills.

> Bookmark-based recovery requires the method to expose a `PagingBookmark` (or, for legacy IPS methods, a parameter-level cursor — see [`../03-paging-and-updates/04-paging-in-ips.md`](../03-paging-and-updates/04-paging-in-ips.md)).

### "Set" methods (create / amend / delete)

Recovery varies by category:

- **Safely retryable**: amend a record that may or may not exist (e.g. `AdminUserCreate2` with `AmendIfExists=true`).
- **Idempotency-keyed**: pass a unique `OrderTag` (or equivalent) on create — the server rejects duplicates within a small window, preventing double-sends.
- **State-check required**: read the current state before retrying. Don't blindly retry `OrderCreate3` — you may end up with two orders.

## Per-method-category guidance

| Category | Recovery | Doc |
|---|---|---|
| Iress WebAdmin "set" methods (`AdminUserCreate2`, `AccountCreate`, etc.) | Use `AmendIfExists=true` where supported. Otherwise: retrieve, then decide create vs amend. | [`02-iress-webadmin-recovery.md`](02-iress-webadmin-recovery.md) |
| IOS+ Admin "set" methods | Same as Iress WebAdmin. | [`03-iosplus-admin-recovery.md`](03-iosplus-admin-recovery.md) |
| IOS+ order retrieval (live + on startup) | Two-step reconciliation with overlap handling. | [`04-iosplus-order-retrieval-recovery.md`](04-iosplus-order-retrieval-recovery.md) |
| IOS+ order creation | `OrderTag`-based idempotency. Use `OrderNoGetByOrderTag` to recover. | [`05-iosplus-order-creation-recovery.md`](05-iosplus-order-creation-recovery.md) |
| IPS transactions / accounts / positions | Standard modern paging for `*5` methods; legacy cursor paging for older methods. | [`../03-paging-and-updates/`](../03-paging-and-updates/) |
| IPS uploads | Each upload has an `UploadNumber`; safe to re-run only the `IPSUploadRun1` step if the previous run failed. | [`../05-services/ips/uploads/`](../05-services/ips/uploads/) |
| FIX+ | Status check is naturally idempotent; nothing special. | [`../05-services/fixplus/01-fixplus.md`](../05-services/fixplus/01-fixplus.md) |

## Decision flowchart

```
                ┌──────────────────────┐
                │  call returned error │
                └──────────┬───────────┘
                           │
              Is it a session error?
              (25006/25009/25014/25019/25022/25033)
                           │
                  ┌────────┴────────┐
                  │                 │
                 yes                no
                  │                 │
                  ▼                 ▼
         rebuild session    ┌────────────────────────────┐
         and retry          │ Is this a "Get" or "Set"?  │
                            └────────────┬───────────────┘
                                         │
                                ┌────────┴────────┐
                                │                 │
                               Get               Set
                                │                 │
                                ▼                 ▼
                       bookmark-based       ┌────────────────────┐
                       recovery + retry     │ Can it be retried  │
                                            │ safely?            │
                                            └────────┬───────────┘
                                                     │
                                            ┌────────┴────────┐
                                            │                 │
                                           yes                no
                                            │                 │
                                            ▼                 ▼
                                       retry with       check state first;
                                       backoff          use idempotency key
                                                          if available
```
