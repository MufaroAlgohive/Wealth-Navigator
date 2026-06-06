# Take-Profit Pattern (IFDONE + AUTODESK + FIXED CO)

The classic take-profit bracket in IOS+ uses **three destinations in combination**:

- `AUTODESK` for the **parent** entry order (BUY).
- `IFDONE` for the **child** take-profit order, linked to the parent.
- `FIXED CO` for the **trigger** that activates the take-profit when the price condition is met.

> The PDF explicitly cites this combination: "This example uses the combinations of the IFDONE, AUTODESK and FIXED CO destinations."

## Flow

```
        Parent BUY
        (AUTODESK destination)
              │
              │ parent fully or partially fills
              ▼
        Child SELL becomes active
        (IFDONE destination, linked to parent)
              │
              │ child's trigger condition is met
              ▼
        FIXED CO trigger fires
        (FIXED CO destination; attached to the child)
              │
              ▼
        Take-profit SELL executes at the limit price
```

## Step-by-step

1. **Parent order** (entry): place on the `AUTODESK` destination, e.g. `BUY 1 000 SHP @ MKT`.
2. **Child order** (take-profit): place on the `IFDONE` destination, linked to the parent. The child is a `SELL 1 000 SHP @ R 260 LMT`.
3. **Trigger** (FIXED CO): when the parent fills, the IFDONE child activates **but is gated by a FIXED CO condition** — e.g. only fire the SELL if the last price is **greater than or equal to R 259** (to avoid selling into a brief dip).

> The exact layering of IFDONE and FIXED CO (which is the parent of which) and the `ExecutionInstructions` set on each order is **destination-specific**. Confirm with the WSDL and the IOS+ admin config.

## Order attribute summary

| Destination | Attributes (typical) |
|---|---|
| AUTODESK (parent) | none / standard. |
| IFDONE (child) | link to parent order; possibly the trigger reference. |
| FIXED CO (trigger) | `IS013`, `IS020`, `IS021`, `IS022` — the price condition. |

## SOAP request (illustrative)

> The exact request shape varies. The PDF shows the example; see [`../../../13-soap-examples/order-take-profit.request.xml`](../../../13-soap-examples/order-take-profit.request.xml) for the full payload.

```text
-- Parent
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP", Exchange = "JSE",
  BuySell = 1, OrderType = "MKT", Volume = 1000,
  Destination = "AUTODESK",
  TimeInForce = "DAY",
  OrderTag = "mint-tp-parent-..."
)

-- Child (IFDONE, with FIXED CO trigger inside)
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP", Exchange = "JSE",
  BuySell = 2, OrderType = "LMT", Volume = 1000, Price = 260.00,
  Destination = "<IFDONE_destination>",
  ParentOrderNumber = "<parent.OrderNumber>",
  OrderTag = "mint-tp-child-...",
  ExecutionInstructionsArray = {
    "IS013(Security.Exchange)",
    "IS020(Last)",
    "IS021(Greater or Equal)",
    "IS022(259.00)"
  }
)
```

## Recovery considerations

- If the parent fills but the child doesn't activate, query `OrderPadGetByAccount` and check the child's `IS016` status (`Pre-Active` → `Active` → `Triggered`).
- If the child stays `Pre-Active` past the parent's fill, something is wrong with the IFDONE link — cancel and re-enter.

## See also

- [`03-fixed-co.md`](03-fixed-co.md) — the trigger side.
- [`06-ifdone.md`](06-ifdone.md) — the linkage side.
- [`01-destinations-and-identification.md`](01-destinations-and-identification.md) — finding destination codes.
