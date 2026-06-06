# 04 — Paging in IPS (Legacy Methods)

A few IPS methods were built **before** V4 was released, and they expose their paging parameters in the `<v4:Parameters>` block rather than the standard V4 header. The calling pattern is the same, but the cursor lives in a different place.

## Affected methods

The source PDF explicitly calls out:

- `IPSAccountGetAll1`
- `IPSPositionGetAll1`

Other older methods may follow the same shape. When in doubt, check the WSDL — newer methods use header-level `PagingBookmark`; older ones don't.

## The pattern

1. Make the first call with an **empty** cursor (often `"?"` or empty string).
2. The response may show `StatusCode = 2` (finished) **but still contain rows that indicate "more data is on the IPS server"**.
3. Take the **last row's key value** and pass it as the new cursor in the **next call** (using a **new** `RequestID`).
4. Continue until the response is empty.

## Example: `IPSAccountGetAll1`

First call (RequestID = `TESTPAGING`):
```xml
<v4:IPSAccountGetAll1>
  <v4:Input>
    <v4:Header>
      <v4:ServiceSessionKey>664b5291-5e45-4849-8d1c-74ca38402cd0@WebServicesTestA.iress.com.au</v4:ServiceSessionKey>
      <v4:RequestID>TESTPAGING</v4:RequestID>
      <v4:Updates>false</v4:Updates>
      <v4:Timeout>25</v4:Timeout>
      <v4:PageSize>0</v4:PageSize>
      <v4:WaitForResponse>true</v4:WaitForResponse>
      <v4:PagingBookmark><!-- empty --></v4:PagingBookmark>
      <v4:PagingDirection>0</v4:PagingDirection>
    </v4:Header>
    <v4:Parameters>
      <v4:PageSize>200</v4:PageSize>
      <v4:PreviousAccountCode>?</v4:PreviousAccountCode>
    </v4:Parameters>
  </v4:Input>
</v4:IPSAccountGetAll1>
```

Response (excerpt — note `StatusCode = 2`):
```xml
<IPSAccountGetAll1Response xmlns="http://webservices.iress.com.au/v4/">
  <Output>
    <v4:Input xmlns:v4="http://webservices.iress.com.au/v4/">
      <!-- echoed input -->
    </v4:Input>
    <Result>
      <Header>
        <RequestID>TESTPAGING</RequestID>
        <StatusCode>2</StatusCode>
        <WebServiceTimeStamp>2020-09-28T19:51:45</WebServiceTimeStamp>
        <PagingBookmark/>
      </Header>
      <HeaderRow/>
      <DataRows>
        <!-- ...rows including a last account with AccountCode "AccountCode" ... -->
      </DataRows>
    </Result>
  </Output>
</IPSAccountGetAll1Response>
```

The "last account" returned is the one you must use as the `PreviousAccountCode` in the next call. Use a **new** `RequestID`:

```xml
<v4:IPSAccountGetAll1>
  <v4:Input>
    <v4:Header>
      <v4:ServiceSessionKey>817ab46b-f588-4bc8-beb1-0286d7f516ff@WebServicesTestA.iress.com.au</v4:ServiceSessionKey>
      <v4:RequestID>TESTPAGING1</v4:RequestID>
      <v4:Updates>false</v4:Updates>
      <v4:Timeout>25</v4:Timeout>
      <v4:PageSize>0</v4:PageSize>
      <v4:WaitForResponse>true</v4:WaitForResponse>
      <v4:PagingBookmark><!-- empty --></v4:PagingBookmark>
      <v4:PagingDirection>0</v4:PagingDirection>
    </v4:Header>
    <v4:Parameters>
      <v4:PageSize>200</v4:PageSize>
      <v4:PreviousAccountCode>PreviousAccountCode</v4:PreviousAccountCode>
    </v4:Parameters>
  </v4:Input>
</v4:IPSAccountGetAll1>
```

Repeat until the response has zero rows (or fewer than `PageSize`).

## Why this matters

- ⚠️ **Status code 2 is NOT a stop signal on these methods.** It only means "this page is done; there may be more on the server." The cursor is the truth.
- The empty header `PagingBookmark` is misleading; ignore it. Use the parameter-level cursor.

## Mint OEMS implications

For Mint's nightly reconciliation, you'll likely page through:

- `IPSAccountGetAll1` — every account → reconcile portfolio count.
- `IPSPositionGetAll1` — every position → reconcile against the OEMS book.
- `IPSTransactionGetByAccount5` — per-account transactions, this one is **modern** and uses the header-level `PagingBookmark` like everything else.

Wrap both paging patterns in a single internal interface:

```ts
interface PageCursor {
  // for modern methods, the opaque bookmark returned by the server
  bookmark?: string;
  // for legacy IPS methods, the last key value (e.g. account code)
  legacyKey?: string;
}
```

The client code is identical; only the field used to resume differs.
