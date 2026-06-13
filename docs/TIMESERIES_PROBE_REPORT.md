# TimeSeriesGet2 — `Interval` / `Frequency` Live-CT Probe Report

**Date:** 2026-06-13 13:49 UTC
**Worker:** `Iress-Worker` (Railway project `dacf9008-a4e8-450c-b5f0-f8a749ec47b4`, service `a4fd8932-534b-4296-ac71-b6fcbb3c1cf4`)
**Worker code:** UNTOUCHED. Read-only probe.

---

## 1. Worker public URL

- **URL:** `https://iress-worker-production.up.railway.app`  (port 8765, auth off as expected)
- **How found:** Railway GraphQL `service.serviceInstances.edges[].node.domains.serviceDomains[]` returned `domain: "iress-worker-production.up.railway.app"`, `targetPort: 8765`.
- **Service instance id:** `b2aa89bd-42fc-47fc-a619-03c837d3f7f1` (env `79cba157-5cc4-4dc5-916e-bc67a0f585ec`), latest deployment `e8d9ce30-6ff5-44a7-ae3c-5241deddc451` (SUCCESS).

---

## 2. Probe results table (33 candidates)

All candidates sent `POST {code: "J203", interval: <value>}` → `https://iress-worker-production.up.railway.app/debug/timeseries-probe`. The worker forwards every accepted string to the SOAP body as `<Interval>{value}</Interval>` (verified in `wealth-navigator/workers/iress-ingest/src/http-api.ts:178` and `src/lib/iress/live.ts:885-891`).

| # | `interval` value | HTTP | `ok` | `errorNumber` | `dataRowCount` | `rawFault` |
|---|---|---|---|---|---|---|
| 1 | `Daily` | 200 | false | 50 | 0 | `soap:Receiver — Invalid Parameter Value:  as Frequency` |
| 2 | `Weekly` | 200 | false | 50 | 0 | (same) |
| 3 | `Monthly` | 200 | false | 50 | 0 | (same) |
| 4 | `Quarterly` | 200 | false | 50 | 0 | (same) |
| 5 | `Yearly` | 200 | false | 50 | 0 | (same) |
| 6 | `IntraDay` | 200 | false | 50 | 0 | (same) |
| 7 | `Intraday` | 200 | false | 50 | 0 | (same) |
| 8 | `intraDay` | 200 | false | 50 | 0 | (same) |
| 9 | `daily` (lowercase) | 200 | false | 50 | 0 | (same) |
| 10 | `weekly` | 200 | false | 50 | 0 | (same) |
| 11 | `monthly` | 200 | false | 50 | 0 | (same) |
| 12 | `quarterly` | 200 | false | 50 | 0 | (same) |
| 13 | `yearly` | 200 | false | 50 | 0 | (same) |
| 14 | `intraday` | 200 | false | 50 | 0 | (same) |
| 15 | `D` | 200 | false | 50 | 0 | (same) |
| 16 | `W` | 200 | false | 50 | 0 | (same) |
| 17 | `M` | 200 | false | 50 | 0 | (same) |
| 18 | `Q` | 200 | false | 50 | 0 | (same) |
| 19 | `Y` | 200 | false | 50 | 0 | (same) |
| 20 | `1` | 200 | false | 50 | 0 | (same) |
| 21 | `2` | 200 | false | 50 | 0 | (same) |
| 22 | `3` | 200 | false | 50 | 0 | (same) |
| 23 | `4` | 200 | false | 50 | 0 | (same) |
| 24 | `5` | 200 | false | 50 | 0 | (same) |
| 25 | `6` | 200 | false | 50 | 0 | (same) |
| 26 | `7` | 200 | false | 50 | 0 | (same) |
| 27 | `8` | 200 | false | 50 | 0 | (same) |
| 28 | `9` | 200 | false | 50 | 0 | (same) |
| 29 | `10` | 200 | false | 50 | 0 | (same) |
| 30 | `TICK` | 200 | false | 50 | 0 | (same) |
| 31 | `MINUTE` | 200 | false | 50 | 0 | (same) |
| 32 | `HOUR` | 200 | false | 50 | 0 | (same) |
| 33 | `EOD` | 200 | false | 50 | 0 | (same) |
| — | `` (empty) | 400 | false | — | — | worker-side `bad_request`: "interval is required…" |

**No candidate produced `ok: true` or `dataRowCount > 0`.** Every non-empty value produced the **identical** fault.

Full response for `interval=Daily`:
```json
{"ok":false,"code":"J203","exchange":"JSE","interval":"Daily",
 "errorNumber":50,"errorDescription":null,
 "rawFault":"soap:Receiver — Invalid Parameter Value:  as Frequency",
 "dataRowCount":0,"firstRow":null,
 "iressMode":"live","elapsedMs":245,
 "probedAt":"2026-06-13T11:49:23.523Z"}
```

---

## 3. Winning value

**None.** All 33 candidates failed with the same `errorNumber: 50` SOAP fault. The probe handler does not expose a way to set the SOAP field name — it hardcodes `Interval` in the wire payload (`http-api.ts:178`).

---

## 4. Server fault analysis

The raw fault string is, byte-for-byte:

```
soap:Receiver — Invalid Parameter Value:  as Frequency
```

Note the **double space** between `:` and `as`. That double space is the smoking gun: it is the IRESS fault template literal `Invalid Parameter Value: %s as Frequency` with the value-position rendered as the empty string. Translation:

- The live CT server is parsing whatever XML element we send as the **`Frequency`** field, **not** `Interval`.
- It successfully received `<Interval>Daily</Interval>` but the server is *reading* that value (or empty value) into a `Frequency` slot whose declared XSD type is `xsd:long`.
- The value reaches the fault as empty (the double space), so the server is effectively saying: "the value I read into the `Frequency` long-typed slot is empty / not a valid long — please correct it."
- This is consistent with a live-CT behaviour where `Frequency` is a mandatory `long` field and `Interval` is a separate string field that the live server does **not** use.

This matches the in-repo interface comment at `src/lib/iress/client.ts:119-121` which already documents that *"the live CT server rejects `Frequency: 8` (Long)"* — the prior team's notes confirm Frequency is the live field name.

The WSDL doc (`Documentation & Vision/iress-v4-docs/05-services/market-data/02-time-series-get-2.md`) shows `<Interval>Daily</Interval>` as the V4 sample payload, but the **live CT runtime** is a different schema than the WSDL — the IRESS CT instance is exposing `Frequency` (long) and either ignoring or not exposing `Interval` (string).

---

## 5. Recommendation

**Switch the wire payload from `Interval` (string) to `Frequency` (Long).** The current `timeSeriesGet2` call in `src/lib/iress/live.ts:885-891` and the worker probe both serialize `Interval`. The live CT server only honours `Frequency`. Concrete change (illustrative — not applied):

```ts
// src/lib/iress/live.ts — timeSeriesGet2
parameters: {
  Code: req.Code,
  Exchange: req.Exchange,
  From: req.From,
  To: req.To,
  Frequency: 8,   // <- Long; 8 = daily per IRESS V4 Frequency enum (to be confirmed)
}
```

The probe endpoint is hardcoded to `Interval`, so to **empirically verify** the right `Frequency` value we need to (a) modify the probe handler to accept a `frequency` field, redeploy, and re-probe candidates `0..10`, or (b) flip `live.ts` to send `Frequency` directly and watch the worker's structured logs for a non-fault response on J203. **Either way the worker code must change** — the `Interval` path is provably dead on the live CT server.
