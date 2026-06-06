# OCO (One-Cancels-Other)

OCO is a pair of orders where filling one automatically cancels the other. Classic bracket entry: a buy limit and a sell stop, where whichever hits first cancels the other.

## Trigger semantics

- Two orders are linked as a pair.
- When one order fully or partially fills, the other is cancelled.

## Attributes (per source PDF)

| Attribute | Required | Description |
|---|---|---|
| `IS016` | auto | Contingent order status (read-only flag set by STI): `Active`, `Triggered`, `Deleted`, `Pre-Active`. |

> The OCO pair relationship is established by the destination; the individual orders don't carry their own OCO-specific attributes — they're just two orders against the same `OCO` destination, linked by some pair-id mechanism defined by the destination.

## How to set up an OCO pair

The PDF is light on details. The typical pattern is:

1. Place order A against the `OCO` destination.
2. Place order B against the same `OCO` destination.
3. The destination links them as a pair.
4. When one fills, the destination cancels the other.

> Confirm the exact pair-linking mechanism with the IRESS Vol-2 docs / WSDL — it may be a `PairId` parameter, a `LinkedOrderNumber` field, or implicit by submission time.

## Example (textual)

"OCO: BUY 1 000 SHP @ R 250 LMT **and** SELL 1 000 SHP @ R 240 STP. Whichever hits first cancels the other."

```text
-- Order A
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP", Exchange = "JSE",
  BuySell = 1, OrderType = "LMT", Volume = 1000, Price = 250.00,
  Destination = "<OCO_destination>",
  OrderTag = "mint-oco-A-...",
  ...
)

-- Order B
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP", Exchange = "JSE",
  BuySell = 2, OrderType = "STP", Volume = 1000, StopPrice = 240.00,
  Destination = "<OCO_destination>",
  OrderTag = "mint-oco-B-...",
  ...
)
```

## See also

- [`02-attributes.md`](02-attributes.md) — full attribute reference.
- [`01-destinations-and-identification.md`](01-destinations-and-identification.md) — finding the destination code.
