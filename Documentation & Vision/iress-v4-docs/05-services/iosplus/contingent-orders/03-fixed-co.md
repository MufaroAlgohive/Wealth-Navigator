# FIXED CO

A FIXED CO becomes active when a contingency security's price reaches a **fixed price level** relative to a base price (last, bid, or ask).

## Trigger semantics

- **Base price** (`IS020`): one of `Last`, `Bid`, `Ask`.
- **Condition** (`IS021`): one of `Greater`, `Less`, `Equal`, `Greater or Equal`, `Less or Equal`.
- **Trigger price** (`IS022`): the absolute price level to compare against.

Example: "If the last trade of SHP is **greater than or equal to** R 250.00, then activate the contingent order."

## Required attributes (per source PDF)

| Attribute | Required | Description |
|---|---|---|
| `IS013` | yes | Contingency security (exchange). |
| `IS016` | auto | Contingent order status. Set by STI: `Active`, `Triggered`, `Deleted`, `Pre-Active`. |
| `IS020` | yes | Contingency base price: `Last`, `Bid`, or `Ask`. |
| `IS021` | yes | Condition: `Greater`, `Less`, `Equal`, `Greater or Equal`, `Less or Equal`. |
| `IS022` | yes | Trigger price (float). |
| `IS028`–`IS041` | no | Notification / audit preferences. |

## Example (textual)

"Buy 1 000 SHP @ R 251.00 LMT, contingent on the **last** trade of SHP being **greater than or equal to** R 250.00. Email the trader on trigger."

```text
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP",
  Exchange = "JSE",
  BuySell = 1,                   -- BUY
  OrderType = "LMT",
  Volume = 1000,
  Price = 251.00,
  Destination = "<FIXED_CO_destination>",
  TimeInForce = "DAY",
  OrderTag = "mint-co-...",
  ExecutionInstructionsArray = {
    "IS013(Security.Exchange)",          -- the contingency security's exchange
    "IS020(Last)",
    "IS021(Greater or Equal)",
    "IS022(250.00)",
    "IS028(true)",                        -- email on trigger
    "IS041(trader@mint.co.za)"
  }
)
```

## See also

- [`02-attributes.md`](02-attributes.md) — full attribute reference.
- [`07-take-profit.md`](07-take-profit.md) — practical pattern that uses FIXED CO together with IFDONE and AUTODESK.
- [`01-destinations-and-identification.md`](01-destinations-and-identification.md) — finding the destination code.
