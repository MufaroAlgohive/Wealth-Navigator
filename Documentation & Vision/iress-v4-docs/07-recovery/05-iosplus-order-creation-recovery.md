# IOS+ Order Creation — Recovery (Idempotency)

`OrderCreate3` is the highest-stakes "set" call in the OEMS: a double-send can mean a double-fill. The recovery pattern is built around the **`OrderTag`** input parameter.

## The core idea

> **Always set `OrderTag` to a unique value (e.g. the OEMS order id).** If the same tag is sent twice within a small window (typically 5 minutes), the IOS+ server **rejects the second send with a "duplicate tag" error** instead of placing the order again.

This makes the call idempotent in practice: the worst case is a recoverable error, not a duplicate fill.

## What to put in `OrderTag`

- A **stable, unique-per-intent** identifier.
- For Mint: use the OEMS order's internal id (e.g. `mint-ord-{uuid}`).
- For re-attempts after a recoverable error: **keep the same `OrderTag`** — that's the whole point.

## What if you never get a response?

If the client never receives a response (network drop, timeout, etc.):

1. **Don't immediately retry with a new `OrderTag`** — you may double-send.
2. Call `OrderNoGetByOrderTag(OrderTag = "<your tag>")` to ask IOS+ if the order exists.
3. If found → the order was placed; you have the IOS+ `OrderNumber`.
4. If not found → the order was not placed; safe to retry with the **same** `OrderTag`.
5. If `OrderNoGetByOrderTag` itself is inconclusive (timing edge case) → **retry with backoff** on the same call. The order may not be in the database yet — IRESS explicitly recommends this.

> *"When using this method, it is recommended to implement a retry system if a match is not initially found for the given order tag, given there may be delays on the order being committed into the database."*

## Sequence

```
   ┌──────────────────────────────────┐
1. │ OrderCreate3(OrderTag=X)         │
   └─────────────┬────────────────────┘
                 │
         ┌───────┴───────┐
         │               │
     response        no response
     received        (timeout/drop)
         │               │
         ▼               ▼
   parse result    OrderNoGetByOrderTag(X)
   store order        │
         │       ┌────┴────┐
         │       │         │
         │   found      not found
         │       │         │
         │       ▼         ▼
         │   use OrderNumber  retry OrderCreate3
         │                    (same OrderTag X)
         │                         │
         │                  ┌──────┴──────┐
         │                  │             │
         │              created       duplicate-tag
         │              (success)     error (caught)
         │                  │             │
         │                  └──────┬──────┘
         │                         ▼
         │                  use OrderNumber
         ▼
   continue
```

## Bulk sends

For bulk `OrderCreate3` calls, every `DataRow` should have a **unique** `OrderTag`. If the server detects a duplicate tag, the whole bulk call fails — there's no partial. The per-row `ErrorNumber` will indicate the duplicate.

## See also

- [`../05-services/iosplus/01-order-create-amend-cancel.md`](../05-services/iosplus/01-order-create-amend-cancel.md)
- [`../05-services/iosplus/02-order-pad.md`](../05-services/iosplus/02-order-pad.md)
- [`01-application-recovery.md`](01-application-recovery.md)
