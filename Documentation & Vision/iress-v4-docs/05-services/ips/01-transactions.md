# IPS — Transactions (IPSTransactionGetByAccount5)

`IPSTransactionGetByAccount5` returns the **transaction history** for an IPS account — the canonical record of all activity affecting that account (trades, journals, corporate actions, accruals, fees, etc.).

- **Service:** IPS.
- **Header token:** `ServiceSessionKey`.
- **Updates support:** No.
- **Paging:** Yes, with bookmarks.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `AccountCode` | string | yes | The IPS account code. |
| `DateFrom` | date | no | Start of the date range. |
| `DateTo` | date | no | End of the date range. |
| (other filters) | various | no | Per the WSDL. |

## Return value

A `DataRow` per transaction. Fields include:

- `TransactionId`, `TransactionType`
- `AccountCode`
- `SecurityCode`, `Exchange`
- `TradeDate`, `SettlementDate`
- `Quantity`, `Price`, `NetAmount`, `Currency`
- `BookingNumber` (links to IOS+ booking)
- `OrderNumber` (links to IOS+ order)
- `Reference`, `Description`
- `ErrorNumber`, `ErrorMessage`

> The exact column set is method-specific. Confirm with the WSDL.

## Pagination

Uses standard V4 paging — set `PageSize` and use `PagingBookmark` to resume. The `*5` suffix on the method name suggests this is the fifth generation; it follows the standard modern paging pattern (unlike the older `IPSAccountGetAll1` / `IPSPositionGetAll1` — see [`../../../03-paging-and-updates/04-paging-in-ips.md`](../../../03-paging-and-updates/04-paging-in-ips.md)).

## Sample payload

Request:
```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <IPSTransactionGetByAccount5 xmlns="http://webservices.iress.com.au/v4/">
      <Input>
        <Header>
          <ServiceSessionKey>817ab46b-f588-4bc8-beb1-0286d7f516ff@WebServicesTestA.iress.com.au</ServiceSessionKey>
          <RequestID>tx-1</RequestID>
          <Updates>false</Updates>
          <Timeout>25</Timeout>
          <PageSize>0</PageSize>
          <WaitForResponse>true</WaitForResponse>
          <PagingBookmark></PagingBookmark>
          <PagingDirection>0</PagingDirection>
        </Header>
        <Parameters>
          <AccountCode>MINT-LIVE-001</AccountCode>
          <DateFrom>2025-01-01</DateFrom>
          <DateTo>2025-01-31</DateTo>
        </Parameters>
      </Input>
    </IPSTransactionGetByAccount5>
  </soap:Body>
</soap:Envelope>
```

## Mint OEMS — usage notes

- **EOD reconciliation:** pull the day's transactions for every account; cross-check against your internal order book.
- **Settlement reconciliation:** T+1/T+2 — pull the prior day's trades; match to the expected settlement file.
- **Corporate actions:** dividend / distribution / capital events are surfaced as transactions; make sure the OEMS can categorise them.
- **Currency:** multi-currency accounts are common for offshore holdings; preserve the per-transaction `Currency`.
- **Booking linkage:** use `BookingNumber` to jump to the IOS+ [`BookingGetByOrganisation2`](../iosplus/03-bookings.md) row for fee breakdown.

## See also

- [`../iosplus/03-bookings.md`](../iosplus/03-bookings.md) — for fee-level detail on a specific trade.
- [`uploads/01-uploads-overview.md`](uploads/01-uploads-overview.md) — for pushing data into IPS (e.g. trade files).
- [`../../../03-paging-and-updates/04-paging-in-ips.md`](../../../03-paging-and-updates/04-paging-in-ips.md) — IPS legacy paging pattern.
