# TimeSeriesGet2

Returns a time series of values for a given security / code, used for historical price retrieval, fitted yield curves, macro time series, and any "give me N data points for code X" request.

- **Service:** Iress.
- **Header token:** `SessionKey` (Iress session only — no service session).
- **Updates support:** Per method reference.
- **Paging:** Yes, with bookmarks for some inputs.
- **Scope for Mint:** JSE daily EOD price history, SARB repo/JIBAR/ZARONIA history, fitted yield curve points, StatsSA / G10 macro series.

## Parameters (request `<Parameters>`)

| Name | Type | Required | Description |
|---|---|---|---|
| `Code` | string | yes | The Iress identifier of the series. Could be a security code (e.g. `SHP`), a curve code (e.g. `ZAR_NSS_5Y`), or a macro code (e.g. `SARB_REPO`). Confirm with your IRESS reference-data feed. |
| `Exchange` | string | depends | e.g. `JSE`, `BLOOMBERG`, `REUTERS`. For curves/macro, often blank or a special code. |
| `Date` | string | no | Single point in time. |
| `DateFrom` | string | no | Start of range. |
| `DateTo` | string | no | End of range. |
| `Interval` | enum | no | `Daily`, `Weekly`, `Monthly`, etc., depending on the series. |
| `NumberOfPoints` | int | no | Limit the response. |
| … | … | … | Other filters available in the WSDL; confirm against the live WSDL. |

## Return value

`DataRows[]` of the time series points. The exact column set is method-specific. For a price series expect: `DateTime, Open, High, Low, Close, Volume`. For a fitted curve expect: `Tenor, Yield`.

## Updates

`TimeSeriesGet2Updates` (if available) lets you subscribe to updates. Use it for live-tape use cases (e.g. streaming the SARB repo rate as it changes intra-day).

## Sample payload

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <TimeSeriesGet2 xmlns="http://webservices.iress.com.au/v4/">
      <Input>
        <Header>
          <SessionKey>ABCD1234-...@WebServicesTestA.iress.com.au</SessionKey>
          <RequestID>ts-1</RequestID>
          <Updates>false</Updates>
          <Timeout>25</Timeout>
          <PageSize>0</PageSize>
          <WaitForResponse>true</WaitForResponse>
          <PagingBookmark></PagingBookmark>
          <PagingDirection>0</PagingDirection>
        </Header>
        <Parameters>
          <Code>SHP</Code>
          <Exchange>JSE</Exchange>
          <DateFrom>2025-01-01</DateFrom>
          <DateTo>2025-12-31</DateTo>
          <Interval>Daily</Interval>
        </Parameters>
      </Input>
    </TimeSeriesGet2>
  </soap:Body>
</soap:Envelope>
```

## Mint OEMS — common call patterns

| Need | Call shape |
|---|---|
| EOD price history for a JSE equity | `Code = "SHP"`, `Exchange = "JSE"`, range, daily. |
| ZARONIA fixings history | `Code = "<ZARONIA code>"`, no exchange, range, daily. |
| JIBAR fixings history | `Code = "<JIBAR code>"`, no exchange, range, daily. |
| NSS-fitted ZAR yield curve | `Code = "<curve code>"`, exchange blank or curve-feed-specific. |
| SARB repo rate history | `Code = "<SARB repo code>"`, range, daily. |
| StatsSA CPI history | `Code = "<CPI code>"`, range, monthly. |

> The exact code strings are an **IRESS reference-data** question. Confirm with the IRESS Vol-2 reference-data feed when defining the Mint static config.

## See also

- [`PricingQuoteGet`](03-pricing-quote-get.md) — point-in-time snapshot.
- [`../market-data/01-iress-session-start.md`](01-iress-session-start.md) — for the session lifecycle.
