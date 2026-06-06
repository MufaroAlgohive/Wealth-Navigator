# IFDONE (If-Done)

IFDONE links a parent order to a child: the child only becomes active if the parent is **fully or partially** filled. Classic use: enter a position, then automatically place a take-profit or stop-loss as soon as the entry fills.

## Trigger semantics

- **Parent order** is placed on any normal destination (e.g. `AUTODESK`, an exchange).
- **Child order** is placed on the `IFDONE` destination, with a link to the parent.
- When the parent fully or partially fills, the child activates.

## Attributes (per source PDF)

| Attribute | Required | Description |
|---|---|---|
| `IS016` | auto | Contingent order status (read-only flag set by STI): `Active`, `Triggered`, `Deleted`, `Pre-Active`. |

> Like OCO, IFDONE attributes are minimal — the linkage is the key, not the order attributes.

## How to set up an IFDONE pair

The typical pattern is:

1. Place parent order on its destination.
2. Place child order on the `IFDONE` destination, referencing the parent.
3. The child activates when the parent fills.

> Confirm the parent-reference mechanism (e.g. `ParentOrderNumber` parameter) with the IRESS Vol-2 docs / WSDL.

## Example (textual)

"BUY 1 000 SHP @ MKT. When filled, SELL 1 000 SHP @ R 260 LMT (take-profit)."

```text
-- Parent
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP", Exchange = "JSE",
  BuySell = 1, OrderType = "MKT", Volume = 1000,
  Destination = "AUTODESK",
  OrderTag = "mint-ifd-parent-...",
  ...
)

-- Child
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP", Exchange = "JSE",
  BuySell = 2, OrderType = "LMT", Volume = 1000, Price = 260.00,
  Destination = "<IFDONE_destination>",
  OrderTag = "mint-ifd-child-...",
  ParentOrderNumber = "<parent.OrderNumber>",   -- confirm field name in WSDL
  ...
)
```

## See also

- [`07-take-profit.md`](07-take-profit.md) — the canonical take-profit pattern (IFDONE + AUTODESK + FIXED CO).
- [`01-destinations-and-identification.md`](01-destinations-and-identification.md) — finding the destination code.
