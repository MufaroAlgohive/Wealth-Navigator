# 04 — Getting Started

End-to-end first-call recipe. By the end of this page you will have placed a `PricingQuoteGet` against the South Africa test environment and printed the result.

## 0. Pre-flight

- [ ] You have a **Web Services permission** at the group level in Iress Web Administration. Without it the WSDL won't generate.
- [ ] You have: **Iress username**, **company name**, **password**, and (for IOS+/IPS/FIX+ methods) the **server name** (e.g. `IOSPLUSAPI`).
- [ ] You have set `Accept-Encoding: gzip` on your HTTP client.
- [ ] You have picked the right endpoint — for Mint, start in the SA test: `https://webservices-ct.iress.co.za/v4`.

## 1. Generate / fetch the WSDL

### 1a. Via browser (manual)
```
https://webservices-ct.iress.co.za/v4
```
Click **WSDL**, fill in the form, download the file. Save it as a reference inside your VCS — see [`09-compatibility/01-wsdl-compatibility.md`](../09-compatibility/01-wsdl-compatibility.md) for why this matters.

### 1b. Via the .NET / Java WSDL tool

- **.NET** (`dotnet` / `svcutil`):
  ```bash
  dotnet svcutil https://webservices-ct.iress.co.za/v4?wsdl \
    --namespace "*,Mint.Oems.Iress.V4" \
    --outputDir ./Generated
  ```
  Pass `--methodFilter` to narrow (depends on tooling; for `dotnet svcutil` you typically edit the WSDL first).

- **Java** (`wsimport` / `cxf-codegen-plugin`):
  ```bash
  wsimport -keep -p mint.oems.iress.v4 \
    https://webservices-ct.iress.co.za/v4?wsdl
  ```

- **Node** (use a generic SOAP client such as `strong-soap` or a code-generated client):
  ```bash
  # Generate TS types from WSDL with wsdl-tsclient
  npx wsdl-tsclient -i https://webservices-ct.iress.co.za/v4?wsdl \
    -o ./src/iress/v4/types
  ```

> Save a copy of the raw WSDL alongside your generated code. Diff on every upgrade.

## 2. Open an Iress session

Call `IRESSSessionStart`. See [`../04-sessions/01-iress-sessions.md`](../04-sessions/01-iress-sessions.md) for the full method, and [`../13-soap-examples/iress-session-start.request.xml`](../13-soap-examples/iress-session-start.request.xml) for the SOAP payload.

Request parameters (input `<Parameters>` block):

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `UserName` | string | yes | Iress login name |
| `CompanyName` | string | yes | |
| `Password` | string | yes | |
| `ApplicationID` | string | yes | Must be **unique per call**. Pattern: `Mint-OEMS-<GUID>`. |
| `ApplicationLabel` | string | no | Free text, e.g. `Mint-OEMS-Production` |
| `AuthenticationType` | string | no | Defaults to native credentials; LDAP/SSO if entitled |
| `SessionTimeout` | int (minutes) | no | Max `1440` (24h); subject to group policy |
| `SessionNumberToKick` | int | no | See [User Scenarios](../04-sessions/03-user-scenarios.md) |
| `KickLikeSessions` | bool | no | Used with `SessionNumberToKick` |
| `Locale` | string | no | e.g. `en-ZA` |
| `LocalePrivateUseSubtags` | string | no | |

On success the response `<Result>` includes an `IRESSSessionKey` — a token (often suffixed with the originating web-server hostname, e.g. `ABCD-…@WebServicesTestA.iress.com.au`).

> **Best practice:** persist the `IRESSSessionKey` and `ApplicationID` together so reconnection uses the same identity.

## 3. (Optional) Open a service session for IOS+, IPS, or FIX+

If you will call any method on these services, call `ServiceSessionStart` **after** `IRESSSessionStart`.

```text
ServiceSessionStart(IRESSSessionKey=<key>, Service="IOSPlus", Server="IOSPLUSAPI")
  → ServiceSessionKey
```

See [`../04-sessions/02-service-sessions.md`](../04-sessions/02-service-sessions.md).

## 4. Make your first market-data call

```text
PricingQuoteGet(securityCode="SHP", exchange="JSE")
  → HeaderRow, DataRows[]
```

That's it. You do not need a service session for `PricingQuoteGet` — it is an Iress Pro method reachable with just the Iress session key.

## 5. End the sessions

```text
ServiceSessionEnd(ServiceSessionKey=<key>)   ← only if you opened one
IRESSSessionEnd(IRESSSessionKey=<key>)
```

If the app crashes, the sessions will end by themselves via the **2-hour idle timeout**, but a clean shutdown is preferred to free the user license promptly.

## 6. Error handling — minimum

Wrap every call in a try/catch (or equivalent in your language) and inspect for:

1. **SOAP fault** (`<soap:Fault>`) — system errors, network issues, server offline.
2. **`StatusCode = 1`** — more data; keep paging with the same `RequestID`.
3. **`StatusCode = 3`** — watching; keep long-polling updates.
4. **`ErrorNumber != 0`** in `DataRow` — data error (per-row, on set methods).
5. **Session error codes 25006/25009/25019/25033** — service session died; rebuild and retry.
6. **Session error codes 25014/25019/25022** — Iress session died; rebuild and retry.

See [`../06-errors/01-session-error-codes.md`](../06-errors/01-session-error-codes.md) and [`../07-recovery/01-application-recovery.md`](../07-recovery/01-application-recovery.md).

## 7. Mint OEMS — recommended first build order

1. **Skeleton client** that handles session lifecycle (start, watch, end, recover).
2. **`PricingQuoteGet` & `TimeSeriesGet2`** wired to a thin in-memory cache — proves the loop.
3. **`OrderCreate3` + `OrderPadGetByAccountUpdates`** for a single test account — proves the trading path.
4. **`BookingGetByOrganisation2`** to confirm the fee model.
5. **`IPSTransactionGetByAccount5`** for end-of-day reconciliation.
6. **Layer in FIX+** (`TargetIDStatusGet`) only when you're ready to wire drop-copy.

## 8. Smoke test checklist (run before every release)

- [ ] `IRESSSessionStart` returns within 5s on the prod endpoint.
- [ ] Forcing `SessionNumberToKick = -1` on a fresh login returns a valid `IRESSSessionKey` (Scenario 2 in [`../04-sessions/03-user-scenarios.md`](../04-sessions/03-user-scenarios.md)).
- [ ] `PricingQuoteGet` on a known JSE security returns a row.
- [ ] `OrderCreate3` for a market order on a sandbox account goes to working state within 2s.
- [ ] `OrderPadGetByAccountUpdates` returns the same order with status updates.
- [ ] `BookingGetByOrganisation2` returns at least one booking after the test order.
- [ ] `ServiceSessionEnd` + `IRESSSessionEnd` both return successfully.
- [ ] Killing the network mid-session and re-establishing it triggers the recovery path (test error 25014 → re-login → re-call).
