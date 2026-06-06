# Error Schema

Two layers: SOAP fault (system errors) and per-row data error (set methods).

## SOAP fault shape

```xml
<soap:Envelope>
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Receiver</faultcode>
      <faultstring>Error: …</faultstring>
      <detail>
        <IRESSFaultDetail xmlns="http://webservices.iress.com.au/v4/">
          <Message>Error: …</Message>
          <Number>25008</Number>                           <!-- canonical error code -->
          <Context><![CDATA[ <CurrentSessions> … </CurrentSessions> ]]></Context>
          <Service>IRESS</Service>
          <Server>AU1-T-MASTERA:4501 (PHOENIX)</Server>
          <Method/>
          <UserName>buyside</UserName>
          <CompanyName>Iress</CompanyName>
          <EndPoint>https://webservicestesta.iress.com.au/v4/SOAP.aspx</EndPoint>
          <RequestID>Login/Logout - E1B41264-…</RequestID>
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

## `IRESSFaultDetail` fields

| Field | Type | Description |
|---|---|---|
| `Message` | string | Human-readable description. **Don't** match on this. |
| `Number` | int | Canonical error code. **Match on this.** |
| `Context` | string (CDATA) | Opaque context blob. For 25008 it contains a `<CurrentSessions>` list. |
| `Service` | string | `IRESS`, `IOSPlus`, `IPS`, `FIXPlus`. |
| `Server` | string | The Phoenix node. |
| `Method` | string | (where applicable) |
| `UserName` | string | |
| `CompanyName` | string | |
| `EndPoint` | string | The URL the call hit. |
| `RequestID` | string | The `RequestID` from the call. |
| `SessionKey` | string | (echoed, may be empty) |
| `ServiceSessionKey` | string | (echoed, may be empty) |
| `WebServiceTimeStamp` | dateTime | When the fault was produced. |
| `WebServiceServer` | string | The web server (load-balanced). |
| `WebServiceConnection` | string | The backend (Phoenix) connection. |
| `Input` | complex | Echoed request input. |

## Per-row data error (on set methods)

On methods that accept bulk input (e.g. `OrderCreate3`, `IPSUploadDataSet1`), each `DataRow` may include:

| Field | Type | Description |
|---|---|---|
| `ErrorNumber` | int | Non-zero = error. |
| `ErrorMessage` | string | Optional. Non-empty = error. |
| `ErrorDescription` | string | Optional. Non-empty = error. |
| `ErrorRows` | array | On some methods, a separate array of error rows. |

> Match on `ErrorNumber` (the numeric code), not on the message text.

## See also

- [`../06-errors/01-session-error-codes.md`](../06-errors/01-session-error-codes.md) — error number table.
- [`../06-errors/02-application-error-management.md`](../06-errors/02-application-error-management.md) — handling pattern.
