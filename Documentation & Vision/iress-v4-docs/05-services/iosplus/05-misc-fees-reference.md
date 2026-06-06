# IOS+ — MiscFees Reference (Quick Lookup)

Single-page lookup for the `<MiscFees>` blocks inside bookings. See [`03-bookings.md`](03-bookings.md) for the full narrative.

## `FeeType` enum

| Code | Name | SWIFT | Notes |
|---|---|---|---|
| 0 | Unknown | `OTHR` | Iress-internal only. |
| 1 | Regulatory | `REGF` | |
| 2 | GST | `VATA` | "Tax" in FIX protocol. |
| 3 | LocalCommission | `LOCO` | |
| 4 | ExchangeFees | `REGF` | |
| 5 | Stamp | `STAM` | |
| 6 | Levy | `LEVY` | |
| 7 | Other | `OTHR` | |
| 8 | Markup | `OTHR` | |
| 9 | ConsumptionTax | `COAX` | |
| 10 | PerTransaction | `OTHR` | |
| 11 | Conversion | `OTHR` | |
| 12 | Agent | `OTHR` | |
| 13 | TransferFee | `OTHR` | |
| 14 | SecurityLending | `OTHR` | |
| 15 | Research | `OTHR` | |

## `FeeBasis` enum

| Code | Name | Use with `Properties`? |
|---|---|---|
| 0 | Absolute | No — `FeeAmount = rate`. |
| 1 | PerUnit | No — `FeeAmount = rate * Volume`. |
| 2 | Percentage | Yes. |

## `Properties` enum (only when `FeeBasis = 2`)

| Code | Meaning |
|---|---|
| 0 | % of commission value |
| 1 | % of order value |

## `Set` field

| Code | Meaning |
|---|---|
| 0 | Fee is not set on this booking. |
| 1 | Fee is set on this booking. |

## `Display` field

| Code | Meaning |
|---|---|
| 0 | Don't display in IOS+ booking command. |
| 1 | Display in IOS+ booking command. |

Configurable via IOS+ Administration > Bookings > Fees.

## `FeeAmount` formula

| Basis | Properties | Formula | Example (rate = 10) |
|---|---|---|---|
| 0 (Absolute) | — | `10` | `10` |
| 1 (PerUnit) | — | `10 * Volume` | `10 * 1 000 = 10 000` |
| 2 (Percentage) | 0 | `10% * commission` | `0.10 * commission` |
| 2 (Percentage) | 1 | `10% * (price * volume)` | `0.10 * orderValue` |

## SWIFT qualifier (default mapping)

| FeeType | SWIFTQualifier |
|---|---|
| 0 | `OTHR` |
| 1 | `REGF` |
| 2 | `VATA` |
| 3 | `LOCO` |
| 4 | `REGF` |
| 5 | `STAM` |
| 6 | `LEVY` |
| 7 | `OTHR` |
| 8 | `OTHR` |
| 9 | `COAX` |
| 10 | `OTHR` |
| 11 | `OTHR` |
| 12 | `OTHR` |
| 13 | `OTHR` |
| 14 | `OTHR` |
| 15 | `OTHR` |

> Configurable in IOS+ Administration > Bookings > Fees; the above are production defaults.
