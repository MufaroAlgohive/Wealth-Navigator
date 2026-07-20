# SENS — `NewsHeadlineGet` working wire (2026-07-20)

> Captured against the live MINT_CT IRESS Pro build
> (`za1-ct-ds1.prod.iress.com.au:4502`, TLS) via the worker's
> `POST /debug/soap-raw`. Two days of probes confirmed:

1. The story-fetching verb on this CT build is **`NewsHeadlineGet`**, **NOT**
   `NewsVendorGet` (which only returns the vendor catalog — 1 row of
   `{VendorCode, VendorDescription}`).
2. The vendor code that the prod market-data session accepts is **`SENSD`**
   ("SENS NEWS DELAYED"). `SENS` (real-time) faults with
   `"No valid vendor specified"`.
3. The session that returns real (non-test) SENS announcements is the
   **prod market-data session** (`useMarketData: true` on the probe,
   resolved by `getMarketDataSession()` inside the worker). The base
   IRIS session returns test fixtures even with the same parameters.

## Working envelope

### Request

```xml
<Header>
  <SessionKey>…</SessionKey>
  <RequestID>raw-mrtdivz2-n7foc0</RequestID>
  <WaitForResponse>true</WaitForResponse>
  <PagingBookmark></PagingBookmark>
  <PagingDirection>0</PagingDirection>
  <Updates>false</Updates>
  <Timeout>25</Timeout>
  <PageSize>5</PageSize>
</Header>
<Parameters>
  <VendorCode>SENSD</VendorCode>
  <DateTimeStart>2026-07-20T00:00:00</DateTimeStart>
  <DateTimeEnd>2026-07-20T23:59:59</DateTimeEnd>
  <Count>5</Count>
</Parameters>
```

Note: **`DateTimeStart` / `DateTimeEnd` are ISO-NAIVE** (no trailing
`Z`). Sending `2026-07-20T00:00:00Z` causes the server to throw
`"The DateTimeStart parameter must be provided."` despite the field
being present. CT's date parser is naive-local-time.

### Response

`errorNumber: 0`, `dataRowCount: 40` (real announcements on the prod
market-data session; 17 on the base session, which is test-fixture
content). Each data row carries:

```json
{
  "HeadlineID":          "1092605212989864208",
  "HeadlineDateTime":    "2026-07-20T15:00:00.000",
  "HasTextStory":        true,
  "HasURL":              false,
  "HasHTMLTextStory":    false,
  "HeadlineText":        "Vesting of Shares Awarded to Directors and Disposal of Shares",
  "SecurityCodeList":    "EMI",
  "ExchangeList":        "JSE",
  "MarketSensitiveList": "*",
  "VendorCode":          "SENSD",
  "CategoryIDList":      "105000000",
  "StoryURL":            "",
  "MarketSensitive":     true,
  "NewsSummary":         "Vesting of Shares Awarded to Directors …"
}
```

Important gotcha: the server emits the paging bookmark on a
**separate header row** with `HeadlineID` as `{ "@_xsi:nil": true }`
(or, after the first page, a real bookmark id). The live client
filters those out via `r["HeadlineID"] !== "string"` before mapping.

## What failed (history)

| Probe                                          | Result                                                                   |
|------------------------------------------------|--------------------------------------------------------------------------|
| `NewsVendorGet { Vendor:"SENS" }`              | `errorNumber:0, dataRowCount:1` — only vendor-catalog row. Not stories.  |
| `NewsVendorGet { Vendor:"IRESS" }`             | `dataRowCount:0` — no entitlement to plain IRESS vendor.                 |
| `NewsVendorGet { Vendor:"SENSD", MaxResults }` | `dataRowCount:1` — still just the catalog row.                           |
| `NewsVendorGet { Vendor:"SENSD", StartDate/EndDate }` | Same. The vendor-catalog method ignores date filters.              |
| `NewsStoryGet`                                 | `code:25004, "Method NewsStoryGet does not exist"`.                      |
| `NewsStoryGet2`                                | Same.                                                                    |
| `NewsHeadlinesGet`                             | Same.                                                                    |
| `NewsHeadlineGet { Vendor:"SENS" }`            | `code:-1, "No valid vendor specified"`. The vendor code is wrong.        |
| `NewsHeadlineGet { Vendor:"SENSD", Count:20 }` (no dates) | Same. Without dates the server rejects.                       |
| `NewsHeadlineGet { VendorCode:"SENSD", DateTimeStart, DateTimeEnd, Count }` (base session) | 17 rows — all CT test fixtures (`"Test Announcement 21"`, etc.). |
| `NewsHeadlineGet { VendorCode:"SENSD", DateTimeStart, DateTimeEnd, Count }` + `useMarketData:true` | **40 rows — real SENS announcements.** ✅ |

## What changed in code

- `src/lib/iress/client.ts` — replaced `NewsVendorGetRequest` / `NewsStory`
  with `NewsHeadlineGetRequest` / updated `NewsStory` to match the
  CT build shape.
- `src/lib/iress/live.ts` — `newsHeadlineGet` calls
  `NewsHeadlineGet` with `VendorCode / DateTimeStart / DateTimeEnd / Count`,
  strips the paging-bookmark header row, returns the mapped set.
- `src/lib/iress/mock.ts` — mock honours the new request shape and
  still returns an empty page (T5 still passthrough-only).
- `workers/iress-ingest/src/http-api.ts` —
  `/debug/news-vendor-probe` now resolves
  `getMarketDataSession()` (the prod market-data seat) and forwards
  `vendor` / `dateFrom` / `dateTo` / `pageSize` / `timeout`. New helper
  signature: `probeNewsVendor(deps, vendor, dateTimeStart, dateTimeEnd, pageSize, timeout, includeBody)`.
- `src/app/api/iress/news/route.ts` — default vendor flipped from
  `"SENS"` to `"SENSD"`; accepts `dateFrom` / `dateTo` query params
  for non-default windows.
- `src/__tests__/iress-mock.test.ts` — three tests renamed for
  `newsHeadlineGet` and now also assert the missing-date-window 25018.

## What the UI does with this

`src/app/oems/news/page.tsx` reads `?vendor=SENSD` from
`/api/iress/news` (Path B passthrough). No persistence layer yet — the
UI hydrates from the worker's response in flight. The "blocked-vendor"
badge collapses on data; it stays when `dataRowCount: 0`.
