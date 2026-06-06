# Master Index — All Pages

Generated table of contents. Each row links to the modular `.md` file.

## 01 — Foundations

- [01 — Overview](01-foundations/01-overview.md)
- [02 — Architecture](01-foundations/02-architecture.md)
- [03 — Endpoints](01-foundations/03-endpoints.md)
- [04 — Getting Started](01-foundations/04-getting-started.md)

## 02 — Protocol

- [01 — Requests](02-protocol/01-requests.md)
- [02 — Responses](02-protocol/02-responses.md)
- [03 — Synchronous vs Asynchronous Calling](02-protocol/03-sync-vs-async.md)

## 03 — Paging & Updates

- [01 — Paging Overview](03-paging-and-updates/01-paging-overview.md)
- [02 — Paging with Bookmarks](03-paging-and-updates/02-paging-with-bookmarks.md)
- [03 — Updates (long polling)](03-paging-and-updates/03-updates.md)
- [04 — Paging in IPS (legacy methods)](03-paging-and-updates/04-paging-in-ips.md)

## 04 — Sessions

- [01 — Iress Sessions (start / end)](04-sessions/01-iress-sessions.md)
- [02 — Service Sessions (IOS+ / IPS / FIX+)](04-sessions/02-service-sessions.md)
- [03 — User Scenarios (license exhaustion, force-close)](04-sessions/03-user-scenarios.md)
- [04 — Session Error Management & Recovery](04-sessions/04-error-management-and-recovery.md)
- [05 — Session Expiration](04-sessions/05-session-expiration.md)

## 05 — Services

### 5.1 — Iress Pro (Market Data & Web Admin)

- [01 — IRESSSessionStart](05-services/market-data/01-iress-session-start.md)
- [02 — TimeSeriesGet2](05-services/market-data/02-time-series-get-2.md)
- [03 — PricingQuoteGet](05-services/market-data/03-pricing-quote-get.md)

### 5.2 — IOS+ (Order System)

- [01 — Order Create / Amend / Cancel](05-services/iosplus/01-order-create-amend-cancel.md)
- [02 — OrderPadGetByAccount & Updates](05-services/iosplus/02-order-pad.md)
- [03 — Bookings (BookingGetByOrganisation2)](05-services/iosplus/03-bookings.md)
- [04 — ETCs (ETCGetByOrganisation)](05-services/iosplus/04-etcs.md)
- [05 — MiscFees tag reference](05-services/iosplus/05-misc-fees-reference.md)

#### 5.2.1 — Contingent Orders

- [01 — CO Destinations & identification](05-services/iosplus/contingent-orders/01-destinations-and-identification.md)
- [02 — Order attributes (Iress strategy properties)](05-services/iosplus/contingent-orders/02-attributes.md)
- [03 — FIXED CO](05-services/iosplus/contingent-orders/03-fixed-co.md)
- [04 — TRAILING CO](05-services/iosplus/contingent-orders/04-trailing-co.md)
- [05 — OCO](05-services/iosplus/contingent-orders/05-oco.md)
- [06 — IFDONE](05-services/iosplus/contingent-orders/06-ifdone.md)
- [07 — Take profit (IFDONE + AUTODESK + FIXED CO)](05-services/iosplus/contingent-orders/07-take-profit.md)

#### 5.2.2 — Algo Orders

- [01 — Algo destinations](05-services/iosplus/algo-orders/01-destinations.md)
- [02 — Order attributes (External algo properties)](05-services/iosplus/algo-orders/02-attributes.md)

#### 5.2.3 — Order Attributes (master catalog)

- [01 — Attribute reference (IS013–IS041)](05-services/iosplus/order-attributes/01-is-attributes.md)
- [02 — AttributeGetByUser](05-services/iosplus/order-attributes/02-attribute-get-by-user.md)

### 5.3 — IPS (Portfolio System)

- [01 — Transactions (IPSTransactionGetByAccount5)](05-services/ips/01-transactions.md)
- [02 — Uploads — overview](05-services/ips/uploads/01-uploads-overview.md)
- [03 — IPSUploadCreate1](05-services/ips/uploads/02-ips-upload-create-1.md)
- [04 — IPSUploadDataSet1](05-services/ips/uploads/03-ips-upload-data-set-1.md)
- [05 — IPSUploadRun1](05-services/ips/uploads/04-ips-upload-run-1.md)
- [06 — IPSUploadSummaryGet2](05-services/ips/uploads/05-ips-upload-summary-get-2.md)
- [07 — IPSUploadErrorGet1](05-services/ips/uploads/06-ips-upload-error-get-1.md)

### 5.4 — FIX+

- [01 — FIX+ service (TargetIDGet, TargetIDStatusGet)](05-services/fixplus/01-fixplus.md)

## 06 — Errors

- [01 — Session error codes (25001-25035, 666)](06-errors/01-session-error-codes.md)
- [02 — Application error management](06-errors/02-application-error-management.md)
- [03 — FAQ](06-errors/03-faq.md)
- [04 — Support queries — what to send IRESS](06-errors/04-support-queries.md)

## 07 — Recovery

- [01 — Application recovery patterns](07-recovery/01-application-recovery.md)
- [02 — Iress WebAdmin recovery](07-recovery/02-iress-webadmin-recovery.md)
- [03 — IOS+ Admin recovery](07-recovery/03-iosplus-admin-recovery.md)
- [04 — IOS+ order retrieval recovery](07-recovery/04-iosplus-order-retrieval-recovery.md)
- [05 — IOS+ order creation recovery (idempotency)](07-recovery/05-iosplus-order-creation-recovery.md)

## 08 — Performance

- [01 — Client-side optimisations](08-performance/01-client-side-optimisations.md)
- [02 — Server-side limits](08-performance/02-server-side-limits.md)

## 09 — Compatibility

- [01 — WSDL compatibility](09-compatibility/01-wsdl-compatibility.md)

## 10 — Reference

- [API Method Quick Reference (master)](10-reference/quick-reference/00-master.md)
- [Iress Pro](10-reference/quick-reference/01-iress-pro.md)
- [IOS+](10-reference/quick-reference/02-iosplus.md)
- [Contingent Orders](10-reference/quick-reference/03-contingent-orders.md)
- [FIX+](10-reference/quick-reference/04-fixplus.md)
- [IPS](10-reference/quick-reference/05-ips.md)

## 11 — Mint OEMS Addenda

- [01 — Requirements traceability (SA market)](11-mint-oems/01-requirements-traceability.md)
- [02 — South Africa endpoints & env strategy](11-mint-oems/02-sa-endpoints-and-envs.md)
- [03 — Suggested call graph for a JSE order](11-mint-oems/03-call-graph-jse-order.md)
- [04 — Low-hanging-fruit check (email ask)](11-mint-oems/04-low-hanging-fruit.md)

## 12 — Schemas

- [01 — Common header schema](12-schemas/01-common-header.md)
- [02 — Service-specific headers](12-schemas/02-service-headers.md)
- [03 — Error schema](12-schemas/03-error-schema.md)
- [04 — MiscFees enum](12-schemas/04-misc-fees-enum.md)
- [TypeScript interfaces](12-schemas/ts/types.ts)
- [JSON schema fragments](12-schemas/json/header.json)

## 13 — SOAP Examples

- [IRESSSessionStart — request](13-soap-examples/iress-session-start.request.xml)
- [IRESSSessionStart — response](13-soap-examples/iress-session-start.response.xml)
- [ServiceSessionStart (IOS+) — request](13-soap-examples/service-session-start.iosplus.request.xml)
- [ServiceSessionStart (IOS+) — response](13-soap-examples/service-session-start.iosplus.response.xml)
- [OrderCreate3 — request](13-soap-examples/order-create-3.request.xml)
- [OrderCreate3 — response](13-soap-examples/order-create-3.response.xml)
- [OrderAmend2 — request](13-soap-examples/order-amend-2.request.xml)
- [OrderAmend2 — response](13-soap-examples/order-amend-2.response.xml)
- [OrderDelete — request](13-soap-examples/order-delete.request.xml)
- [OrderPadGetByAccount — request](13-soap-examples/order-pad-get-by-account.request.xml)
- [OrderPadGetByAccount — response](13-soap-examples/order-pad-get-by-account.response.xml)
- [BookingGetByOrganisation2 — response (MiscFees excerpt)](13-soap-examples/booking-get-by-organisation-2.miscfees.xml)
- [Take-profit order — request](13-soap-examples/order-take-profit.request.xml)
- [IPSUploadCreate1 / DataSet1 / Run1 / SummaryGet2 / ErrorGet1](13-soap-examples/ips-uploads.xml)
- [TargetIDStatusGet — request/response](13-soap-examples/target-id-status-get.xml)
- [Force-close (SessionNumberToKick = -1) — request](13-soap-examples/force-close-session.request.xml)
