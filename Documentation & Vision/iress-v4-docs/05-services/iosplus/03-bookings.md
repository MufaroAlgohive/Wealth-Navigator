# IOS+ — Bookings (BookingGetByOrganisation2)

`BookingGetByOrganisation2` returns the **booking** for an order — i.e. the executed fill with all fees, taxes, commissions, levies, and SWIFT qualifiers. This is the canonical source for trade-settlement data in the OEMS.

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.
- **Updates support:** No (use `OrderPadGetByAccountUpdates` to track order state, then fetch the booking once state = `FILLED`).
- **Paging:** Yes.
- **Scope for Mint:** settlement file generation, T+1 reconciliation, fee model transparency, client allocation.

## Method

`BookingGetByOrganisation2` — params include the organisation, an account filter, and date range. Check the WSDL for the full parameter list.

## Return value

A `DataRow` per booking with the standard booking fields:

- `BookingNumber`, `OrderNumber`, `TradeNumber`
- `SecurityCode`, `Exchange`, `BuySell`
- `Volume`, `Price`, `TradeDate`, `SettlementDate`
- `AccountCode`, `AccountGroup`, `Trader`
- `Counterparty` (if cross-trade)
- `Commission` (total)
- `<MiscFees>` — array of fee rows, see below
- `Currency`

## `<MiscFees>` structure

Inside each booking, the `<MiscFees>` block contains zero or more `<MiscFee>` rows:

| Field | Type | Description |
|---|---|---|
| `Set` | int | `1` = fee is set on the booking, `0` = not set. |
| `FeeType` | int | See enum below. |
| `FeeBasis` | int | `0` = Absolute, `1` = PerUnit, `2` = Percentage. |
| `Properties` | int | Only relevant if `FeeBasis = 2`. `0` = % of commission, `1` = % of order value. |
| `FeeAmount` | double | Calculated fee amount in the booking currency. |
| `Currency` | string | Used by client allocation only. |
| `Display` | int | Whether this fee displays in the IOS+ booking command (admin-side flag). |
| `SWIFTQualifier` | string | SWIFT qualifier (e.g. `REGF`, `LOCO`, `STAM`, `LEVY`, `OTHR`, `COAX`, `VATA`). |

### `FeeType` enum

| Value | Name | Notes |
|---|---|---|
| 0 | Unknown | Internal Iress only. |
| 1 | Regulatory | SWIFT `REGF`. |
| 2 | GST | SWIFT `VATA` (named "Tax" in FIX protocol). |
| 3 | LocalCommission | SWIFT `LOCO`. |
| 4 | ExchangeFees | SWIFT `REGF`. |
| 5 | Stamp | SWIFT `STAM`. |
| 6 | Levy | SWIFT `LEVY`. |
| 7 | Other | SWIFT `OTHR`. |
| 8 | Markup | SWIFT `OTHR`. |
| 9 | ConsumptionTax | SWIFT `COAX`. |
| 10 | PerTransaction | SWIFT `OTHR`. |
| 11 | Conversion | SWIFT `OTHR`. |
| 12 | Agent | SWIFT `OTHR`. |
| 13 | TransferFee | SWIFT `OTHR`. |
| 14 | SecurityLending | SWIFT `OTHR`. |
| 15 | Research | SWIFT `OTHR`. |

### `FeeAmount` calculation

| `FeeBasis` | `Properties` | Formula | Example (rate = 10) |
|---|---|---|---|
| 0 (Absolute) | — | `FeeAmount = 10` | `10` |
| 1 (PerUnit) | — | `FeeAmount = 10 * Volume` | `10 * 1 000 = 10 000` |
| 2 (Percentage) | 0 (% of commission) | `FeeAmount = 10% * commission value` | `0.10 * commission` |
| 2 (Percentage) | 1 (% of order value) | `FeeAmount = 10% * order value` | `0.10 * (price * volume)` |

### SWIFT qualifier mapping

| `FeeType` | `SWIFTQualifier` |
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

> The mapping is configurable in IOS+ Administration > Bookings > Fees — treat this table as the **default**. The values can be overridden per deployment.

## Sample (MiscFees excerpt)

```xml
<MiscFees>
  <MiscFee>
    <Set>1</Set>
    <FeeType>4</FeeType>
    <FeeBasis>2</FeeBasis>
    <Properties>1</Properties>
    <FeeAmount>25.05</FeeAmount>
    <Currency>ZAR</Currency>
    <Display>1</Display>
    <SWIFTQualifier>REGF</SWIFTQualifier>
  </MiscFee>
  <MiscFee>
    <Set>1</Set>
    <FeeType>2</FeeType>
    <FeeBasis>2</FeeBasis>
    <Properties>0</Properties>
    <FeeAmount>3.76</FeeAmount>
    <Currency>ZAR</Currency>
    <Display>1</Display>
    <SWIFTQualifier>VATA</SWIFTQualifier>
  </MiscFee>
</MiscFees>
```

## Mint OEMS — usage notes

- The `FeeAmount` is the **final calculated** amount; don't recompute on the client. Persist it.
- The `FeeType` is the canonical key; never match on `SWIFTQualifier` (it can be remapped).
- For client allocation, use the per-fee `Currency` rather than the booking's `Currency` (multi-currency bookings exist for cross-border trades).
- T+1 settlement date is set by the venue; trust it.
- Persist `BookingNumber` for life — it's the unique key for downstream re-references.

## See also

- [`01-order-create-amend-cancel.md`](01-order-create-amend-cancel.md) — to find the `OrderNumber` to look up.
- [`02-order-pad.md`](02-order-pad.md) — to watch for `FILLED` state and then fetch the booking.
- [`05-misc-fees-reference.md`](05-misc-fees-reference.md) — quick-reference for the enum tables above.
- [`../../12-schemas/04-misc-fees-enum.md`](../../12-schemas/04-misc-fees-enum.md) — typed enum.
