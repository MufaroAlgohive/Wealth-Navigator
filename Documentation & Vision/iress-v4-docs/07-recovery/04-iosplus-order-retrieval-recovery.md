# IOS+ Order Retrieval — Recovery

How to recover the full set of orders (active + inactive) at startup or after a network drop. Same algorithm works for both.

> Source: "Recovery in scenarios where retrieving orders and order updates with a requirement to know about every order including those that did not go to market."

## Why a two-step process?

- `OrderPadGet*` methods are **fast** but **narrow** in filtering (good for active orders only).
- `OrderSearchGet*` methods support **wider filtering** but are typically **slower**.
- You need to know about every order — including those created and deleted without going to market.

A single broad call would be slow. A two-step call is fast + complete.

## Step 1 — active orders only, with updates

```
OrderPadGetByUser(
  Updates = true,
  OrderFilter = 5,                    -- All active orders
  RequestID = R1
)
```

- Avoid `OrderFilter=6` (today + yesterday) or `OrderFilter=7` (today) here — they cause large overlaps with the updates stream and slow down recovery.
- Long-poll the matching `OrderPadGetByUserUpdates(RequestID=R1)`.
- **Process updates as they arrive** — don't wait for step 2 to finish.

### What if the snapshot is ahead of the updates?

The IRESS server is precise about ordering:

1. The request starts watching first.
2. The snapshot is performed.
3. Any updates between step 1 and step 2 are buffered server-side.
4. Once the snapshot is retrieved, the buffered updates are **played back over the snapshot** — these are **not** returned in the `OrderPadGetByUserUpdates` call.

So the client sees the snapshot in its correct state, then the live updates follow. There can still be a small overlap window — the client must handle it.

## Step 2 — inactive orders since the last known record

```
OrderSearchGetByUser(
  DateTimeFrom = <latest known record timestamp>,
  OrderState = 3                      -- inactive only
)
```

- Don't request active orders here — step 1 already covered them.
- Use the **latest known record timestamp** from the client's own state.

## Handling overlap

Orders can transition from `ACTIVE` to `INACTIVE` between step 1 and step 2. The client must handle duplicates symmetrically:

- For each update from step 1's stream, check if it's already in the step 2 result. If yes, drop.
- For each row in step 2, check if it's already been seen via step 1. If yes, drop.

Order of arrival is non-deterministic — handle both directions.

## See also

- [`../05-services/iosplus/02-order-pad.md`](../05-services/iosplus/02-order-pad.md)
- [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md)
