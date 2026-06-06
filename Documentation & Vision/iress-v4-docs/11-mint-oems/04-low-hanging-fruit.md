# Low-Hanging Fruit (Email Ask)

The email ended with: *"Any low hanging fruits we left behind, please flag."* This page captures the things that are easy to add to the spec — and the things we should ask Charles about that we may have left out.

## Things easy to add to the requirements spec

### 1. **Fix the licensing cap**

The V4 default is **20 000 active sessions per server**. Each OEMS node consumes at least 1 license, plus another for the IOS+ service session, plus another for the IPS service session, plus another for FIX+.

For a 10-node OEMS that's **40 licenses minimum**. Flag this to Charles so he can size the contract.

→ See [`../04-sessions/01-iress-sessions.md`](../04-sessions/01-iress-sessions.md).

### 2. **Use a cut-down WSDL from day one**

The source PDF cites a **45s → <1s** speedup on `IRESSSessionStart` alone when moving from a full WSDL to a cut-down. We should define the cut for each V4 service up front.

→ See [`../01-foundations/03-endpoints.md`](../01-foundations/03-endpoints.md) and [`../09-compatibility/01-wsdl-compatibility.md`](../09-compatibility/01-wsdl-compatibility.md).

### 3. **gzip everything**

Set `Accept-Encoding: gzip` from day one. Free perf win.

→ See [`../08-performance/01-client-side-optimisations.md`](../08-performance/01-client-side-optimisations.md).

### 4. **Always populate `OrderTag`**

Even on "obviously unique" orders. The duplicate-tag guard is a free safety net.

→ See [`../07-recovery/05-iosplus-order-creation-recovery.md`](../07-recovery/05-iosplus-order-creation-recovery.md).

### 5. **Plan for the 01:00 SAST session cliff**

The default group-level session expiry is 01:00 server time. For an OEMS that may run across midnight, this is a gotcha. Plan for it explicitly with `SessionTimeout`.

→ See [`../04-sessions/05-session-expiration.md`](../04-sessions/05-session-expiration.md).

### 6. **Two-step reconciliation on every startup**

For orders, the IRESS-recommended pattern is two-step (active snapshot + inactive search) with overlap handling. Build it once, reuse it for every reconnect.

→ See [`../07-recovery/04-iosplus-order-retrieval-recovery.md`](../07-recovery/04-iosplus-order-retrieval-recovery.md).

### 7. **Hash session keys before logging**

Don't log raw `IRESSSessionKey` / `ServiceSessionKey` in production. SHA-256 is enough for IRESS to identify the session in their logs, and the raw key never leaves your system.

→ See [`../06-errors/04-support-queries.md`](../06-errors/04-support-queries.md).

### 8. **Version the WSDLs in git**

Save the raw WSDL per service, per env, per date. Diff on every refresh. This catches breaking interface changes early.

→ See [`../09-compatibility/01-wsdl-compatibility.md`](../09-compatibility/01-wsdl-compatibility.md).

## Things to ask Charles about

These were left out of the tick-box spec and may bite us later.

### 1. **L2 depth vs L1 extended**

The spec says "Equities L1 / L2". V4's L1 is clear (`PricingQuoteGet`); L2 is less so. Ask Charles whether IRESS exposes a true depth-of-book method, or whether L2 = `PricingQuoteExGet` (extended L1 snapshot). If only extended, the OEMS may need a third-party JSE feed for true L2.

### 2. **SENS delivery**

SENS is listed but the spec doesn't say how it's delivered. Ask whether it's a V4 method, a separate feed, or a per-security news attachment. Plan accordingly.

### 3. **NSS curve codes and shape**

"NSS fitted yield curves" is a requirement. The V4 method is clear (`TimeSeriesGet2`), but the **code and the per-tenor schema** aren't. Ask for:
- The Iress code for the ZAR NSS curve.
- Whether the curve is delivered as points (e.g. 1Y, 2Y, 5Y, 10Y, 20Y, 30Y) or as the NSS parameters (β0, β1, β2, τ, β3 for the 6-parameter Svensson extension).
- Whether `TimeSeriesGet2Updates` is supported (or polling only).

### 4. **Macro data — what is delivered, what is interpolated**

Same question for SARB / StatsSA / G10: which series, at what frequency, with what lag? The OEMS shouldn't assume daily EOD — some macro is monthly, some is quarterly, some is real-time.

### 5. **Pre-trade compliance hooks**

Not in the spec, but critical for an OEMS. Ask if IRESS has any pre-trade compliance methods (e.g. a "validate order" method that returns pre-trade warnings), or whether compliance is purely the OEMS's responsibility.

### 6. **Wires / cash management**

"Wires" is in the spec. The natural V4 path is IPS transactions, but the OEMS may need a separate wires method (e.g. to initiate a payment). Ask whether wires are inbound only (IPS read) or also outbound (IPS upload / set method).

### 7. **FIX+ drop-copy vs FIX+ execution**

FIX+ can be drop-copy (read-only) or execution (write). For the OEMS, drop-copy is more likely. Confirm.

### 8. **SLA — what are we actually signing up to?**

The spec says "SLA". V4 has the server-side limits documented but no formal SLA. Ask Charles for the published SLA (uptime, latency, support response times) and the penalty / credit framework. This is a commercials conversation but technically important.

### 9. **Method entitlements**

Different users may be entitled to different methods (e.g. a junior trader can't place algo orders). The "view destination" permission gates `DestinationDetailGet`. Confirm what the user-roles model looks like in IRESS and how it maps to the OEMS role model.

### 10. **Date / locale conventions**

V4 accepts `Locale` (`en-ZA`). Confirm:
- Dates are ISO-8601.
- Time zone is SAST (UTC+2) by default.
- Public holidays (JSE calendar) are handled server-side (e.g. settlement date rolls automatically).

## See also

- [`01-requirements-traceability.md`](01-requirements-traceability.md)
- [`02-sa-endpoints-and-envs.md`](02-sa-endpoints-and-envs.md)
- [`03-call-graph-jse-order.md`](03-call-graph-jse-order.md)
