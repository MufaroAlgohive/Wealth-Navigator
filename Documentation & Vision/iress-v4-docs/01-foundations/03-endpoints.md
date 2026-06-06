# 03 — Endpoints

IRESS operates region-specific web-service stacks. The South African endpoints are the relevant ones for the Mint OEMS build.

## Region matrix

| Region | Environment | URL | Notes |
|---|---|---|---|
| **South Africa** | Production | `https://webservices.iress.co.za/v4` | Live JSE / ZAR / SARB traffic |
| **South Africa** | Production test | `https://webservices-ct.iress.co.za/v4` | "CT" = Cape Town test environment |
| Australia | Production | `https://webservices4.iress.com.au` | ASX production |
| Australia | Production | `https://webservices.iress.com.au/v4/` | ASX production alt |
| Australia | Production test | `https://webservicestesta.iress.com.au/v4/` | ASX FTE (test A) |
| Australia | Production test | `https://webservicestestb.iress.com.au/v4/` | ASX ETE (test B) |
| Australia | Production test | `https://webservicestestc.iress.com.au/v4/` | ASX FTE (test C) |
| Canada | Production | `https://webservices.iress.ca/v4/` | |
| Canada | Production test | `https://webservicestest.iress.ca/v4/` | |
| Singapore | Production | `https://webservices.iress.com.sg/v4/` | |
| Singapore | Production test | `https://webservicestest.iress.com.sg/v4/` | |
| UK | Production | `https://webservices.iress.co.uk/v4` | |
| UK | Production test | `https://webservicestest.iress.co.uk/v4` | |

> Mint OEMS should use the SA production URL in prod, and the `webservices-ct` URL in pre-prod/staging/load-test. The Australian test endpoints are the public reference environment widely cited in IRESS sample payloads.

## On-prem (Phoenix) deployments

For clients who have their own local Phoenix server, IRESS can also set up V4 locally. In that case the URL is internal and the WSDL is generated against the local Phoenix. This is rare for buy-side OEMS builds and not relevant to the initial Mint scope.

## How to browse the WSDL

1. Open the URL for your region in a browser.
2. Click **WSDL**.
3. Enter:
   - **Service** you wish to use: `IRESS`, `IOSPlus`, `IPS`, or `FIXPlus`
   - **Server** (for IOS+, IPS, FIX+ only — e.g. `IOSPLUSAPI`)
   - **Iress username**
   - **Iress company name**
   - **Iress password**
   - **Method filter** (optional — comma-separated method names to include)
4. Submit. The WSDL is **dynamically generated** only if the credentials validate.

### Why use the method filter?

A full WSDL contains every method available in V4. For the Mint OEMS, the tooling only needs a fraction (e.g. `OrderCreate3,OrderAmend2,OrderDelete,OrderPadGetByAccount,OrderPadGetByAccountUpdates,BookingGetByOrganisation2,ETCGetByOrganisation`). Cutting the WSDL down to those methods:

- **Speeds up WSDL retrieval** (one anecdote in the source PDF: 45s → <1s on `IRESSSessionStart` with a cut-down WSDL).
- **Improves IDE responsiveness** in Visual Studio.
- **Reduces compile-time surface** for type generation.

### Mint OEMS — recommended WSDL cuts

| WSDL | Methods to include |
|---|---|
| IRESS | `IRESSSessionStart,TimeSeriesGet2,PricingQuoteGet,PricingQuoteExGet,PricingTradeHistoricalGet` (extend once Vol-2 methods are confirmed) |
| IOSPlus | `ServiceSessionStart,OrderCreate3,OrderAmend2,OrderDelete,OrderPadGetByAccount,OrderPadGetByAccountUpdates,OrderPadGetByUser,OrderPadGetByUserUpdates,OrderSearchGetByUser,OrderNoGetByOrderTag,BookingGetByOrganisation2,ETCGetByOrganisation,DestinationGet,DestinationDetailGet,AttributeGetByUser,SessionRequestEnd,ServiceSessionEnd,IRESSSessionEnd` |
| IPS | `IPSTransactionGetByAccount5,IPSAccountGetAll1,IPSPositionGetAll1,IPSUploadCreate1,IPSUploadDataSet1,IPSUploadRun1,IPSUploadSummaryGet2,IPSUploadErrorGet1` |
| FIXPlus | `TargetIDGet,TargetIDStatusGet` |

(Confirm the full Vol-2 method list with IRESS — see `11-mint-oems/01-requirements-traceability.md`.)
