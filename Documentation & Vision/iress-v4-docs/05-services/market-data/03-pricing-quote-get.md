# PricingQuoteGet

Returns a snapshot price quote for a security — best bid/offer, last trade, volume, etc. Use this for L1 pricing; for L2 depth, check the WSDL (e.g. `PricingQuoteExGet`).

- **Service:** Iress.
- **Header token:** `SessionKey` (Iress session only).
- **Updates support:** Yes — see `PricingQuoteGetUpdates`.
- **Paging:** No.
- **Scope for Mint:** real-time JSE L1 quote display, ticker, pre-trade pricing for order entry.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `SecurityCode` | string | yes | e.g. `SHP`. |
| `Exchange` | string | yes | e.g. `JSE`. |
| … | … | no | Optional filters as per WSDL (e.g. board, currency). |

## Return value

A `DataRow` with the snapshot fields — typically:

- `SecurityCode`, `Exchange`
- `LastTrade`, `LastTradeDateTime`
- `Bid`, `BidSize`, `Ask`, `AskSize`
- `Open`, `High`, `Low`, `Close`, `Volume`
- `Currency`
- `MarketState` (e.g. `OPEN`, `PRE_OPEN`, `CLOSED`, `HALT`)
- … and any other fields the live WSDL exposes

The exact schema is in the WSDL. Use the method reference to confirm.

## Updates (`PricingQuoteGetUpdates`)

For a live ticker, follow the snapshot+updates pattern:

1. `PricingQuoteGet(Updates=true, RequestID=R1)` — get the initial snapshot.
2. Page through the snapshot (rarely needed for a single security, but the pattern is identical to the other methods).
3. When `StatusCode = 3`, call `PricingQuoteGetUpdates(RequestID=R1)` continuously, long-polling.
4. Render each new quote in the UI.

## Limits

- The 10 000-row queue limit applies to the update stream. For a single security, you should not hit it.
- For 1 000 securities in a watchlist, **split them across many requests** with different `RequestID`s rather than fetching one per `RequestID` — see [`../../08-performance/01-client-side-optimisations.md`](../../08-performance/01-client-side-optimisations.md).

## Sample payload

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <PricingQuoteGet xmlns="http://webservices.iress.com.au/v4/">
      <Input>
        <Header>
          <SessionKey>ABCD1234-...@WebServicesTestA.iress.com.au</SessionKey>
          <RequestID>quote-1</RequestID>
          <Updates>false</Updates>
          <Timeout>25</Timeout>
          <PageSize>0</PageSize>
          <WaitForResponse>true</WaitForResponse>
          <PagingBookmark></PagingBookmark>
          <PagingDirection>0</PagingDirection>
        </Header>
        <Parameters>
          <SecurityCode>SHP</SecurityCode>
          <Exchange>JSE</Exchange>
        </Parameters>
      </Input>
    </PricingQuoteGet>
  </soap:Body>
</soap:Envelope>
```

## Mint OEMS — usage notes

- A **JSE pre-open** quote may be missing `LastTrade`; the UI must handle null fields gracefully.
- **Currency** is per-security; for ZAR-denominated JSE equities it's `ZAR`. The OEMS should not assume.
- For Z instruments (retail bonds), the exchange code may differ; confirm with the IRESS reference-data feed.
- For **NCD pricing**, `SecurityCode` will be the NCD's Iress code and `Exchange` is the appropriate Z market. Confirm with IRESS.

## See also

- [`TimeSeriesGet2`](02-time-series-get-2.md) — historical series.
- [`../../03-paging-and-updates/03-updates.md`](../../03-paging-and-updates/03-updates.md) — long-polling pattern.
