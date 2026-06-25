# NewsVendorGet Integration — Final Report

**Date:** 2026-06-25
**Status:** Code wired + tested. **Live probe pending worker redeploy (awaiting user approval).**

---

## What changed (file paths)

### Code

- `wealth-navigator/src/lib/iress/client.ts` — Added `NewsVendor` union type, `NewsVendorGetRequest`, `NewsStory` interfaces, and `newsVendorGet(req)` method signature on `IressClient`.
- `wealth-navigator/src/lib/iress/live.ts` — Implemented live `newsVendorGet` with SOAP envelope builder mirroring `pricingQuoteGet`, plus `mapNewsStory` XML→object normalizer with TODO comments for entitlement-blocked fields (Story body, RelatedCodes, Category).
- `wealth-navigator/src/lib/iress/mock.ts` — Added mock `newsVendorGet` that returns empty `DataRows` with `ErrorNumber=0` (T5 no-fabrication) and throws `IressError(25018)` if `Vendor` is missing.
- `wealth-navigator/workers/iress-ingest/src/http-api.ts` — Added `NewsProbeRow` / `NewsProbeResult` types, `newsProbeThrottleOrError` rate-limit helper (default 10s gap, env `NEWS_PROBE_MIN_GAP_MS`), `probeNewsVendor` function, and `GET /debug/news-vendor-probe` route (live-only, vendor/pageSize/timeout/IncludeBody params).
- `wealth-navigator/src/app/api/iress/news/route.ts` (NEW) — BFF passthrough. Returns 200 with `unconfigured`/`T5_NOT_PERSISTED` payload in mock mode; proxies the worker probe when `IRESS_WORKER_URL` is set. Validates vendor query param, clamps pageSize (≤1000), timeout (≤25).
- `wealth-navigator/src/__tests__/live-queries.test.ts` — Added `newsVendorGet: vi.fn()` to `makeMockLiveClient` to satisfy the interface.
- `wealth-navigator/src/__tests__/iress-mock.test.ts` — Added 2-test suite covering the mock's empty-page + 25018-throw behaviour.

### Documentation

- `wealth-navigator/docs/DATA_PROVENANCE.md` — Added `T5_PASSTHROUGH` badge to legend; new "T5 — News (vendor content)" section detailing source, persistence policy (none), vendor parameters, wire shape (Charles' example), worker probe details, BFF passthrough logic, and open questions. Updated Infrastructure table to include `BFF news (Path B)` and `Worker read-only HTTP` table to include `/debug/news-vendor-probe`. Updated Cockpit "News flow" row to `NewsVendorGet` (T5_PASSTHROUGH).
- `wealth-navigator/docs/REMAINING_GAPS.md` — Marked "News source TBD" gap as wired (`NewsVendorGet`); added new Charles action item for live entitlement + body-vs-headline confirmation.
- `wealth-navigator/docs/ISSUES_LOG.md` — Appended section "0.5 News / SENS adapter — wired (2026-06-25)" summarising implementation, probe, BFF, mock, tests, typechecks, and pending live probe.
- `wealth-navigator/docs/IRESS_ISSUES_FOR_ANDRE.md` — Updated open question #9 with partial resolution (Charles confirmed `NewsVendorGet`), the three open sub-questions, and the verification curl command.
- `wealth-navigator/mint-iress-v4-endpoints-likely-basic.txt` — Replaced `<PENDING: News / SENS feed>` with `NewsVendorGet` (Charles-confirmed) + `NewsVendorGetUpdates` (TODO); bumped file version to 2026-06-25.

---

## Verification status

- **Worker typecheck:** `bunx tsc -p workers/iress-ingest/tsconfig.json --noEmit` → exit 0 (clean)
- **Next.js typecheck:** pre-existing errors in `src/app/oems/analysis/[sym]/page.tsx` and `src/components/analysis/analysis-chart.tsx` only (unrelated to this work; documented in ISSUES_LOG)
- **Unit tests:** 159 passed across 5 affected suites (`iress-live`, `iress-mock`, `worker-http-api`, `live-queries`, `order-recovery`). The 2 pre-existing failures in `worker-api.test.ts` (`isWorkerLiveMode` / `isProductionRealDataMode` flag interactions) are not in my path and remain documented in ISSUES_LOG.
- **Live IRESS call:** NOT made — explicit user approval required per standing rule "Do not run local live IRESS… while Railway worker holds the single CT seat". Worker has not been redeployed.

---

## Open questions (need user input)

1. **Default vendor:** **RESOLVED 2026-06-25** — user switched the default from `SENS` → `IRESS` in `client.ts` (NewsVendor doc + `NewsVendorGetRequest.Vendor` JSDoc), `http-api.ts` (probe default + JSDoc), and `/api/iress/news/route.ts` (BFF default). The full `NewsVendor` union (`SENS | IRESS | Reuters | Bloomberg | Moneyweb | Dow Jones | Business Day`) stays valid at every call site, so SENS is still reachable via `?vendor=SENS` on the probe/BFF. Reasoning: Charles confirmed the `DFM@Mint` IRESS Pro entitlement is for the broker feed, and `IRESS` is the more general vendor that covers general market news as well as company announcements.
2. **Story body vs headlines:** IRESS may return headline-only rows depending on entitlement. After probe, if `NewsStory.Story` is empty/populated we either populate or trim the field. Already TODO-flagged in `live.ts`. **Live probe result pending worker redeploy — see "Live probe result" below.**
3. **Caching policy:** Per T5 rule (vendor content — seed until contracted), I left it passthrough-only (no DB writes). Do we want to add a `news_*` table once we have a stable feed? Not in scope of this work.

## Live probe result

To be filled in once the Railway `Iress-Worker` is redeployed and the probe below is called. The probe is read-only — no Supabase writes — so the standing `IRESS_WORKER_DRY_RUN=1` / `SUPABASE_ALLOW_WRITES=0` defaults are NOT being flipped.

```bash
curl 'https://iress-worker-production.up.railway.app/debug/news-vendor-probe?vendor=IRESS&pageSize=10&includeBody=1'
```

The probe respects a per-process 10 s throttle (`NEWS_PROBE_MIN_GAP_MS` env). After the live probe runs the verdict goes here (body populates / headlines-only / entitlement block) and the `REMAINING_GAPS.md` item #6 is closed or narrowed accordingly.