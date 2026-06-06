# TRAILING CO

A TRAILING CO becomes active when a contingency security's price moves a **fixed amount or percentage** off a base price. Useful for "trailing stop"-style logic.

## Trigger semantics

- **Base price** (`IS014`): always `Last`.
- **Trailing type** (`IS025`): `Price` (absolute offset) or `Percentage` (relative offset).
- **Trailing direction** (`IS026`): `Above the base price` (trails up — triggers on a high water mark minus the offset) or `Below the base price` (trails down).
- **Trailing offset** (`IS027`): the offset, in the unit of `IS025`.

Example: "If SHP moves **above the base price by R 5**, then activate the contingent order." As the base moves up, the trigger follows.

## Required attributes (per source PDF)

| Attribute | Required | Description |
|---|---|---|
| `IS013` | yes | Contingency security (exchange). |
| `IS014` | yes | Contingency base price: `Last`. |
| `IS016` | auto | Contingent order status. |
| `IS025` | yes | Trailing type: `Price` or `Percentage`. |
| `IS026` | yes | Trailing direction: `Above the base price` or `Below the base price`. |
| `IS027` | yes | Trailing offset (float). |
| `IS028`–`IS041` | no | Notification / audit preferences. |

## Example (textual)

"Sell 1 000 SHP @ MKT, contingent on SHP's last price trailing **above the base price by R 5.00**. Email on trigger."

```text
OrderCreate3(
  AccountCode = "MINT-LIVE-001",
  SecurityCode = "SHP",
  Exchange = "JSE",
  BuySell = 2,                   -- SELL
  OrderType = "MKT",
  Volume = 1000,
  Destination = "<TRAILING_CO_destination>",
  TimeInForce = "DAY",
  OrderTag = "mint-trail-...",
  ExecutionInstructionsArray = {
    "IS013(Security.Exchange)",
    "IS014(Last)",
    "IS025(Price)",
    "IS026(Above the base price)",
    "IS027(5.00)",
    "IS028(true)",
    "IS041(trader@mint.co.za)"
  }
)
```

## See also

- [`02-attributes.md`](02-attributes.md) — full attribute reference.
- [`01-destinations-and-identification.md`](01-destinations-and-identification.md) — finding the destination code.
