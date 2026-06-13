# TimeSeriesGet2 Probe Report — Empirical Truth (June 13 2026)

This report captures the candidate-vs-response table from the
brute-force `TimeSeriesGet2` probe run against the live IRESS CT
server on Saturday, June 13 2026 at ~12:02–12:05 UTC. It is the
authoritative record for the wire shape of `TimeSeriesGet2` on the
build of `webservices-ct.iress.co.za/v4` the production worker
hits.

## TL;DR — Path B (the `Frequency` Long hypothesis) is blocked

- **No `Frequency` Long value works** on the live CT server. The
  candidate sweep (0..32, 40, 50, 60, 64, 100, 128, 200, 255, 256,
  500, 1000, 2000, 4000, 5000, 10000, 60000, 86400, 604800, 2592000,
  31536000, -1, -2) all returned the same `soap:Receiver — Invalid
  Parameter Value: <n> as Frequency` fault for every symbol tested
  (J203, R2030, NPN, FSR, SOL, USDZAR).
- **The V4 WSDL `<Interval>` (string) form is also rejected**, with
  the same `Invalid Parameter Value: <empty> as Frequency` fault —
  the server requires `Frequency` (Long) at all times, but the
  candidate Longs we swept are not the right values.
- **Until Charles confirms the `TimeSeriesGet2` entitlement on
  `DFM@Mint`**, the worker is still running in the
  `time_series_entitlement_missing` log-event path it already
  had — see `wealth-navigator/workers/iress-ingest/src/timeseries.ts`
  `syncTimeSeries()` for the loop's `entitlementRequired` detection.

The probe infrastructure (worker endpoint + transport support for
`Frequency` (Long)) is in place. The next move is either (a) ask
Charles to enable the entitlement and re-run the probe, or (b)
ask Charles for the correct `Frequency` Long enum (the docs in
this repo are wrong about the wire shape, as the original bug
report said).

## How the probe was run

The probe endpoint at
`POST https://iress-worker-production.up.railway.app/debug/timeseries-probe`
was extended in commit `df2b43b` to accept:

```json
{ "code": "J203", "exchange": "JSE", "frequency": 5 }
```

with a `frequency` Long argument. The body parser also still
accepts the legacy `interval` (string) form for backwards
compatibility. When `frequency` is set, the worker sends
`<Frequency>5</Frequency>` on the wire and drops the `Interval`
string (precedence rule: `Frequency` wins).

The endpoint surfaces the raw IRESS response (`ok`, `errorNumber`,
`rawFault`, `dataRowCount`, …) so the operator can spot the first
non-fault value.

## Candidate-vs-response table — `Frequency` (Long)

Run at 2026-06-13 12:02–12:04 UTC against
`https://iress-worker-production.up.railway.app/debug/timeseries-probe`.
Every entry has `ok=false`, `errorNumber=50`, `errorDescription=null`,
`dataRowCount=0`, `firstRow=null`. The only thing that varies is the
value echoed in `rawFault`.

### J203 (JSE All Share index)

| Frequency | ok | errorNumber | rawFault | dataRowCount |
|----------:|----|------------:|----------|-------------:|
|         0 | false | 50 | `soap:Receiver - Invalid Parameter Value: 0 as Frequency` | 0 |
|         1 | false | 50 | `soap:Receiver - Invalid Parameter Value: 1 as Frequency` | 0 |
|         2 | false | 50 | `soap:Receiver - Invalid Parameter Value: 2 as Frequency` | 0 |
|         3 | false | 50 | `soap:Receiver - Invalid Parameter Value: 3 as Frequency` | 0 |
|         4 | false | 50 | `soap:Receiver - Invalid Parameter Value: 4 as Frequency` | 0 |
|         5 | false | 50 | `soap:Receiver - Invalid Parameter Value: 5 as Frequency` | 0 |
|         6 | false | 50 | `soap:Receiver - Invalid Parameter Value: 6 as Frequency` | 0 |
|         7 | false | 50 | `soap:Receiver - Invalid Parameter Value: 7 as Frequency` | 0 |
|         8 | false | 50 | `soap:Receiver - Invalid Parameter Value: 8 as Frequency` | 0 |
|         9 | false | 50 | `soap:Receiver - Invalid Parameter Value: 9 as Frequency` | 0 |
|        10 | false | 50 | `soap:Receiver - Invalid Parameter Value: 10 as Frequency` | 0 |
|        11 | false | 50 | `soap:Receiver - Invalid Parameter Value: 11 as Frequency` | 0 |
|        12 | false | 50 | `soap:Receiver - Invalid Parameter Value: 12 as Frequency` | 0 |
|        13 | false | 50 | `soap:Receiver - Invalid Parameter Value: 13 as Frequency` | 0 |
|        14 | false | 50 | `soap:Receiver - Invalid Parameter Value: 14 as Frequency` | 0 |
|        15 | false | 50 | `soap:Receiver - Invalid Parameter Value: 15 as Frequency` | 0 |
|        16 | false | 50 | `soap:Receiver - Invalid Parameter Value: 16 as Frequency` | 0 |
|        17 | false | 50 | `soap:Receiver - Invalid Parameter Value: 17 as Frequency` | 0 |
|        18 | false | 50 | `soap:Receiver - Invalid Parameter Value: 18 as Frequency` | 0 |
|        19 | false | 50 | `soap:Receiver - Invalid Parameter Value: 19 as Frequency` | 0 |
|        20 | false | 50 | `soap:Receiver - Invalid Parameter Value: 20 as Frequency` | 0 |
|       100 | false | 50 | `soap:Receiver - Invalid Parameter Value: 100 as Frequency` | 0 |
|      1000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 1000 as Frequency` | 0 |
|        21 | false | 50 | `soap:Receiver - Invalid Parameter Value: 21 as Frequency` | 0 |
|        22 | false | 50 | `soap:Receiver - Invalid Parameter Value: 22 as Frequency` | 0 |
|        23 | false | 50 | `soap:Receiver - Invalid Parameter Value: 23 as Frequency` | 0 |
|        24 | false | 50 | `soap:Receiver - Invalid Parameter Value: 24 as Frequency` | 0 |
|        25 | false | 50 | `soap:Receiver - Invalid Parameter Value: 25 as Frequency` | 0 |
|        26 | false | 50 | `soap:Receiver - Invalid Parameter Value: 26 as Frequency` | 0 |
|        27 | false | 50 | `soap:Receiver - Invalid Parameter Value: 27 as Frequency` | 0 |
|        28 | false | 50 | `soap:Receiver - Invalid Parameter Value: 28 as Frequency` | 0 |
|        29 | false | 50 | `soap:Receiver - Invalid Parameter Value: 29 as Frequency` | 0 |
|        30 | false | 50 | `soap:Receiver - Invalid Parameter Value: 30 as Frequency` | 0 |
|        31 | false | 50 | `soap:Receiver - Invalid Parameter Value: 31 as Frequency` | 0 |
|        32 | false | 50 | `soap:Receiver - Invalid Parameter Value: 32 as Frequency` | 0 |
|        40 | false | 50 | `soap:Receiver - Invalid Parameter Value: 40 as Frequency` | 0 |
|        50 | false | 50 | `soap:Receiver - Invalid Parameter Value: 50 as Frequency` | 0 |
|        60 | false | 50 | `soap:Receiver - Invalid Parameter Value: 60 as Frequency` | 0 |
|        64 | false | 50 | `soap:Receiver - Invalid Parameter Value: 64 as Frequency` | 0 |
|       128 | false | 50 | `soap:Receiver - Invalid Parameter Value: 128 as Frequency` | 0 |
|       200 | false | 50 | `soap:Receiver - Invalid Parameter Value: 200 as Frequency` | 0 |
|       255 | false | 50 | `soap:Receiver - Invalid Parameter Value: 255 as Frequency` | 0 |
|       256 | false | 50 | `soap:Receiver - Invalid Parameter Value: 256 as Frequency` | 0 |
|       500 | false | 50 | `soap:Receiver - Invalid Parameter Value: 500 as Frequency` | 0 |
|      2000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 2000 as Frequency` | 0 |
|      4000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 4000 as Frequency` | 0 |
|      5000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 5000 as Frequency` | 0 |
|     10000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 10000 as Frequency` | 0 |
|     60000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 60000 as Frequency` | 0 |
|     86400 | false | 50 | `soap:Receiver - Invalid Parameter Value: 86400 as Frequency` | 0 |
|    604800 | false | 50 | `soap:Receiver - Invalid Parameter Value: 604800 as Frequency` | 0 |
|   2592000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 2592000 as Frequency` | 0 |
|  31536000 | false | 50 | `soap:Receiver - Invalid Parameter Value: 31536000 as Frequency` | 0 |
|        -1 | false | 50 | `soap:Receiver - Invalid Parameter Value: -1 as Frequency` | 0 |
|        -2 | false | 50 | `soap:Receiver - Invalid Parameter Value: -2 as Frequency` | 0 |

### Other symbols (R2030, NPN, FSR, SOL, USDZAR) — Frequency 0, 1, 5, 8, 10, 100

Same `Invalid Parameter Value: <n> as Frequency` fault for every
combination. The fault is not symbol-specific — it's a method-level
parameter-validation rejection.

| Code    | Frequencies tried | Result |
|---------|-------------------|--------|
| R2030   | 0, 1, 5, 8, 10, 100 | all `Invalid Parameter Value: <n> as Frequency` |
| NPN     | 0, 1, 5, 8, 10, 100 | all `Invalid Parameter Value: <n> as Frequency` |
| FSR     | 0, 1, 5, 8, 10, 100 | all `Invalid Parameter Value: <n> as Frequency` |
| SOL     | 0, 1, 5, 8, 10, 100 | all `Invalid Parameter Value: <n> as Frequency` |
| USDZAR  | 0, 1, 5, 8, 10, 100 | all `Invalid Parameter Value: <n> as Frequency` |

## Candidate-vs-response table — `Interval` (string, V4 WSDL form)

Same J203 probe, but with the legacy `<Interval>` string. Every
entry has `ok=false`, `errorNumber=50`, `rawFault="soap:Receiver -
Invalid Parameter Value:  as Frequency"` (note the empty value),
`dataRowCount=0`. The server is reading the request as if
`Frequency` were empty, which means the V4 WSDL sample payload
(`<Interval>Daily</Interval>`) is not the accepted shape on this
CT build either.

| Interval     | ok | errorNumber | rawFault | dataRowCount |
|--------------|----|------------:|----------|-------------:|
| `Daily`      | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `Weekly`     | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `Monthly`    | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `Quarterly`  | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `Yearly`     | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `IntraDay`   | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `Intraday`   | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `1d`         | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `1w`         | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `1mo`        | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `1q`         | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `1y`         | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |
| `tick`       | false | 50 | `soap:Receiver - Invalid Parameter Value:  as Frequency` | 0 |

## Winning value

**None.** No `Frequency` Long is accepted, and the V4 WSDL
`<Interval>` (string) form is also rejected. The empirical truth
is: until Charles enables the `TimeSeriesGet2` entitlement (or
provides the correct `Frequency` Long for this CT build), every
`TimeSeriesGet2` call from the worker will fail with
`Invalid Parameter Value: <n> as Frequency`. The worker's
`syncTimeSeries()` loop already detects this and logs
`time_series_entitlement_missing` rather than crashing — the
worker continues to ingest `PricingQuoteGet` quotes, but the
Tier 2 panels (J203, R-codes, sector indices) stay empty.

## What the worker did BEFORE this fix

Commit `7260ed2` ("Bug C follow-up: TimeSeriesGet2 Interval
string enum") had the live client enforce
`Interval: string` and only send `<Interval>Daily</Interval>`.
The probe in this report (run on the production worker after
commit `df2b43b`) confirmed that the V4 WSDL `<Interval>`
string is also rejected, with `Invalid Parameter Value:  as
Frequency` — meaning the V4 WSDL sample is NOT the wire shape
the live CT build expects.

## What the worker does NOW (after commit `df2b43b`)

- `TimeSeriesGet2Request.Frequency?: number` — optional Long.
- `TimeSeriesGet2Request.Interval?: string` — optional string
  (legacy fallback, kept for older IRESS server builds).
- Precedence: when both are set, `Frequency` wins and `Interval`
  is dropped from the wire.
- The live SOAP body sends `<Frequency>N</Frequency>` when
  `Frequency` is set, `<Interval>Daily</Interval>` otherwise.
- If neither is set, the live client throws `IressError(25018)`
  locally (no IRESS call).
- The worker's `timeSeriesFrequencyLong("1d")` resolves to
  `DAILY_FREQUENCY_LONG` — a placeholder constant set to `5`
  pending Charles's confirmation. The next probe that finds a
  non-rejected `Frequency` Long should update this constant.

## Next steps

1. **Ask Charles to enable the `TimeSeriesGet2` entitlement on
   `DFM@Mint`**. Once it's on, the next probe should be able to
   find a `Frequency` Long that returns `ok=true dataRowCount>0`.
2. **Re-run the probe** with the same script (the worker
   endpoint is in place). The first `Frequency` Long that
   returns `ok=true` is the answer.
3. **Update `DAILY_FREQUENCY_LONG`** in
   `wealth-navigator/workers/iress-ingest/src/timeseries.ts`
   to the pinned value, and replace this report with the
   updated candidate-vs-response table that establishes it.

## Files changed by this probe / fix

- `wealth-navigator/src/lib/iress/client.ts` — re-add
  `Frequency?: number` to `TimeSeriesGet2Request`; make
  `Interval` optional.
- `wealth-navigator/src/lib/iress/live.ts` — send
  `<Frequency>N</Frequency>` when `Frequency` is set; fall back
  to `<Interval>Daily</Interval>`; `Frequency` wins precedence;
  25018 if neither is set.
- `wealth-navigator/workers/iress-ingest/src/http-api.ts` —
  `probeTimeSeriesInterval()` accepts an optional `frequency`
  Long argument. Body parser accepts `frequency` (number or
  numeric string). Response surfaces `interval` and `frequency`
  fields.
- `wealth-navigator/workers/iress-ingest/src/timeseries.ts` —
  rename `timeSeriesIntervalString` → `timeSeriesFrequencyLong`;
  `1d` → `DAILY_FREQUENCY_LONG` (placeholder = 5, to be pinned
  by the next probe).
- `wealth-navigator/src/__tests__/iress-live.test.ts` — pin
  the wire shape (`Frequency` on the wire, `Interval` dropped
  when `Frequency` is set), the precedence rule, and the
  missing-both 25018 case.
- `wealth-navigator/src/__tests__/worker-http-api.test.ts` —
  pin the probe endpoint: `Interval` path, `Frequency` path,
  precedence rule, numeric-string coercion.
- `wealth-navigator/src/__tests__/worker-quotes.test.ts` —
  pin the new `timeSeriesFrequencyLong` mapper + the
  `DAILY_FREQUENCY_LONG` placeholder.

## Commit

- `df2b43b` — "fix(iress,worker): TimeSeriesGet2 Frequency Long
  (Bug C part 3)".
