# 02 — Responses

If a method succeeds you receive a `<v4:MethodNameResponse>` (or `<MethodNameResponse>` in the WSDL default namespace) with the data; otherwise a SOAP fault. Either way the envelope shape is the same; only the body changes.

## Success response shape

```
soap:Envelope
└─ soap:Body
   └─ <v4:MethodNameResponse>
      └─ <Output>
         ├─ <Input>           ← echoed back (can be disabled server-side)
         │   └─ …             (same Header + Parameters as the request)
         │
         └─ <Result>
            ├─ <Header>
            │   ├─ <RequestID>
            │   ├─ <StatusCode>           ← 1 / 2 / 3
            │   ├─ <WebServiceTimeStamp>
            │   └─ <PagingBookmark>       ← for next page
            │
            ├─ <HeaderRow>                 ← column metadata, method-specific
            ├─ <DataRows>                  ← array of <DataRow>
            │   └─ <DataRow>
            │       └─ …                  (method-specific output columns)
            │
            └─ <ErrorRows>                 ← array of <ErrorRow>
                └─ <ErrorRow>
                    └─ …                  (per-row errors on bulk set methods)
```

## StatusCode values

| Value | Meaning | Action |
|---|---|---|
| **1** | More data available | Re-call the same method with the same `RequestID` to fetch the next page. |
| **2** | Finished | The request has ended. No more data will arrive. |
| **3** | Watching for updates | The backend is now streaming updates. Switch to calling the matching `*Updates` method with the same `RequestID`. |

## Result components

| Component | Description |
|---|---|
| `Input` | The input echoed back. By default on; can be disabled at the web server level for clients with their own local deployment. Useful for debugging — keep enabled until you go to prod. |
| `Result.Header.RequestID` | The `RequestID` you supplied (or one the server generated for you). |
| `Result.Header.StatusCode` | 1 / 2 / 3. |
| `Result.Header.WebServiceTimeStamp` | Server-side timestamp. Use for latency tracking and reconciliation. |
| `Result.Header.PagingBookmark` | Opaque cursor for the next page. Pass back in the next request. |
| `Result.HeaderRow` | Column metadata, method-specific. |
| `Result.DataRows` | Array of `DataRow` — the actual data. |
| `Result.ErrorRows` | Array of `ErrorRow` — per-row errors on bulk set methods (see below). |

## Per-row errors on "set" methods

Methods that accept bulk input (`OrderCreate3`, `BookingGetByOrganisation2`, `IPSUploadCreate1`, etc.) may return partial success: some rows succeed, some fail. Inspect:

- `DataRow.ErrorNumber` — non-zero indicates an error.
- `DataRow.ErrorMessage` / `ErrorDescription` — non-empty indicates an error.
- `ErrorRows[]` — explicit error collection on some methods.

> The exact column set is method-specific. The source PDF cites `ErrorNumber` and `ErrorMessage` / `ErrorDescription` as the canonical signals. **Do not** match on the description string — match on the number. See [`../06-errors/02-application-error-management.md`](../06-errors/02-application-error-management.md).

## SOAP faults (system errors)

When the request itself fails before the method can produce a result (network, server offline, permission denied, malformed XML), the response is a SOAP fault.

```xml
<soap:Envelope>
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Receiver</faultcode>
      <faultstring>Error: Login failed. No more licenses available for this login. Please contact Support..</faultstring>
      <detail>
        <IRESSFaultDetail xmlns="http://webservices.iress.com.au/v4/">
          <Message>Error: Login failed. No more licenses available for this login. Please contact Support..</Message>
          <Number>25008</Number>
          <Context><![CDATA[ <CurrentSessions> … </CurrentSessions> ]]></Context>
          <Service>IRESS</Service>
          <Server>AU1-T-MASTERA:4501 (PHOENIX)</Server>
          <Method/>
          <UserName>buyside</UserName>
          <CompanyName>Iress</CompanyName>
          <EndPoint>https://webservicestesta.iress.com.au/v4/SOAP.aspx</EndPoint>
          <RequestID>Login/Logout - E1B41264-6E13-4E47-A325-45ABDF502DF5</RequestID>
          <SessionKey/>
          <ServiceSessionKey/>
          <WebServiceTimeStamp>2020-09-23T22:04:12</WebServiceTimeStamp>
          <WebServiceServer>AU1-T-WEBSRVRA:46301</WebServiceServer>
          <WebServiceConnection>AU1-T-MASTERA:4501 (PHOENIX)</WebServiceConnection>
          <v4:Input xmlns:v4="http://webservices.iress.com.au/v4/">
            <!-- echoed request input -->
          </v4:Input>
        </IRESSFaultDetail>
      </detail>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>
```

The `IRESSFaultDetail` block contains:

- `Message` — the human-readable description.
- `Number` — the canonical error code. **Match on this**, not on the string.
- `Context` — opaque blob. For login license errors (25008) it contains a `<CurrentSessions>` list with the sessions that are using the user's licenses — see [`../04-sessions/03-user-scenarios.md`](../04-sessions/03-user-scenarios.md).
- `Service` — which service produced the error (`IRESS`, `IOSPlus`, `IPS`, `FIXPlus`).
- `Server` — the underlying Phoenix node.
- `RequestID` — the request's GUID.
- `WebServiceTimeStamp`, `WebServiceServer`, `WebServiceConnection` — diagnostic breadcrumbs. Include these in every support ticket.

## Mint OEMS — type-model sketch

```ts
type StatusCode = 1 | 2 | 3;

interface IressResponseHeader {
  RequestID: string;
  StatusCode: StatusCode;
  WebServiceTimeStamp: string;     // ISO-8601
  PagingBookmark?: Record<string, unknown>;
}

interface IressResponse<ResultT> {
  Input?: unknown;                  // echoed input
  Result?: {
    Header: IressResponseHeader;
    HeaderRow?: unknown;            // method-specific
    DataRows?: ResultT[];
    ErrorRows?: Array<{ ErrorNumber: number; ErrorMessage?: string }>;
  };
}

interface IressFaultDetail {
  Message: string;
  Number: number;                    // canonical error code
  Context?: string;                  // CDATA, parse case-by-case
  Service?: 'IRESS' | 'IOSPlus' | 'IPS' | 'FIXPlus';
  Server?: string;
  RequestID?: string;
  WebServiceTimeStamp?: string;
  WebServiceServer?: string;
  WebServiceConnection?: string;
}
```

See [`../12-schemas/ts/types.ts`](../12-schemas/ts/types.ts) for the full type set.
