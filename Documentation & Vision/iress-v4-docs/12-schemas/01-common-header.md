# Common Request Header Schema

Every V4 method's request carries the same `Header` block, with very minor differences between an **Iress** request and a **Service** request.

## XSD sketch

```xml
<xs:complexType name="RequestHeader">
  <xs:sequence>
    <xs:element name="SessionKey" type="xs:string" minOccurs="0"/>
    <xs:element name="ServiceSessionKey" type="xs:string" minOccurs="0"/>
    <xs:element name="WaitForResponse" type="xs:boolean" default="true" minOccurs="0"/>
    <xs:element name="PageSize" type="xs:int" default="1000" minOccurs="0"/>
    <xs:element name="RequestID" type="xs:string" minOccurs="0"/>
    <xs:element name="Timeout" type="xs:int" default="25" minOccurs="0"/>
    <xs:element name="Updates" type="xs:boolean" default="false" minOccurs="0"/>
    <xs:element name="PagingBookmark" type="xs:anyType" minOccurs="0"/>
    <xs:element name="PagingDirection" type="xs:int" default="0" minOccurs="0"/>
    <xs:element name="InputLocalizationType" type="xs:int" default="0" minOccurs="0"/>
    <xs:element name="OutputLocalizationType" type="xs:int" default="0" minOccurs="0"/>
  </xs:sequence>
</xs:complexType>
```

> The actual WSDL is **Document/Literal**, so the elements are flattened into the message rather than wrapped in a `Header` complex type. This XSD sketch is a logical view for reference.

## Variants

| Variant | SessionKey | ServiceSessionKey | Used for |
|---|---|---|---|
| **Iress request** | required (after login) | not used | `IRESSSessionStart`, `TimeSeriesGet2`, `PricingQuoteGet`, etc. |
| **Service request** | not used (in body of `ServiceSessionStart`) | required | All IOS+ / IPS / FIX+ methods. |

## Notes

- `PageSize` default `1000`; the server may impose a smaller per-method cap.
- `Timeout` default `25s` for most methods; `55s` for `IRESSSessionStart`.
- `RequestID` should be a GUID.
- `PagingDirection` is `0` (forward); backward is documented but not implemented.

## See also

- [`02-service-headers.md`](02-service-headers.md) — the differences per service.
- [`../02-protocol/01-requests.md`](../02-protocol/01-requests.md) — narrative.
