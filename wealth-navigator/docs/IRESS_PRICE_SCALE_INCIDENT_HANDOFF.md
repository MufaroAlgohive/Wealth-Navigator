# IRESS Price-Scale Corruption — Incident Handoff & Fix Plan

> **Status:** diagnosed, fix designed, NOT yet applied/deployed. Live-DB verification
> still required (must be run from a session with the Supabase MCP connected).
> **Author:** Claude Code session 2026-07-24 (non-interactive; no live DB access).
> **Priority (per Juan):** Railway on IRESS production, clean IRESS data, Yahoo fallback
> that can never corrupt the DB, without merging the WN and MINT systems.

---

## 0. TL;DR

The daily "everything ×100" corruption is **not** an IRESS problem and **not** a Yahoo
problem in isolation — it is a **scale-disambiguation design flaw** that lets either feed
poison the other. The disambiguator (`chooseDisplayCents`) decides cents-vs-Rands by
comparing the incoming price to the **same `securities_c.last_price` column it is about to
overwrite**. That column is written by two independent feeds (WN's IRESS worker and MINT's
`server/index.cjs` Yahoo cron), so:

1. **Seed:** when the reference is missing/zero, an IRESS integer-cents value (e.g. SOL
   `17500`c) is blindly treated as Rands → `×100` → `1,750,000`c (R17,500 instead of R175).
2. **Perpetuate:** once `last_price` holds the ×100 value, the disambiguator sees the next
   ×100 candidate as "matching the reference" and locks it in — every cycle, at the same
   time each day (the full-universe pass). This is exactly Tsie's "I keep fixing it and it
   keeps going back wrong."

**Canonical unit is confirmed CENTS on both sides** — so the fix does not require changing
any consumer; it requires (a) an immutable trusted anchor so disambiguation can't be
poisoned, (b) fail-safe behaviour when scale is unverifiable (skip the money-track write,
never guess), (c) one authoritative writer for the money track, and (d) a one-time data
correction of the already-×100 rows.

---

## 0.1 LIVE VERIFICATION — 2026-07-24 (MCP connected, read-only)

Ran read-only against retail prod (`mfxnghmuccevsxwcetej`). **The money track is currently
CLEAN — no ×100 present**, so no data correction is needed right now.

- All 246 `securities_c` rows carry plausible cents (AGL 83088=R830.88, SOL 20020=R200.20,
  STX40 10171=R101.71). **0** rows ≥ R50k; **0** null/zero.
- `stock_intraday_c`: **0** suspect ticks across all **3.56M** rows (all-time) and last 3 days.
  Latest tick `2026-07-24 16:00:28`.
- **The active ~30–90s writer is Yahoo, not the IRESS worker** — fresh ticks populate `symbol`
  AND `1d_pct`, which the WN worker inserts do NOT set (the Yahoo/MINT pusher does). IRESS
  retail ingest is effectively OFF in prod. So Yahoo currently feeds clean cents; the ×100
  appears only when the **IRESS populate job** runs (no-reference/self-anchor seed → perpetuate).
- Anomaly (NOT ×100): `NPN.JO`=78960 (R789.60), ~5× low for Naspers, stable across ticks →
  stale/bad value. Eyeball against a known source; out of scope for the ×100 fix.

**Revised priority (because data is clean NOW):**
1. Ideal moment to **freeze the current correct `last_price` into the immutable
   `scale_ref_cents`** (SQL runbook STEP 5 + §4B migration). Scale then gets decided against a
   value no tick loop overwrites → IRESS can never ×100 again.
2. The §D data correction (÷100) is likely a **no-op today** — keep it ready in case a future
   IRESS run corrupts before the anchor is in place.
3. Deploy the code below so when IRESS retail ingest is enabled, unverified-scale writes are
   skipped (Yahoo value kept) instead of corrupting.

**Code wired this session (built + typechecked, NOT deployed):**
- `price-scale.ts`: `trustedRefCents` + `scaleVerified` (17/17 tests pass).
- `quotes.ts` + `retail-ingest.ts`: money-track write now SKIPS when `!choice.scaleVerified`
  (keeps the prior Yahoo value). Coverage impact ≈ 0 today (all 246 have an anchor).
- TODO (operator-coordinated, needs migration first): add `scale_ref_cents` to the retail
  universe SELECT and pass it as `chooseDisplayCents(..., trustedRefCents)` — the 1-line change
  that activates the immutable anchor (the perpetuation fix).

---

## 1. The two databases (topology)

Confirmed from `AGENTS.md` line 20 (`docs/DB_TOPOLOGY_DECISION.md`, decided 2026-06-13):

| Supabase ref | Role | Holds |
|---|---|---|
| `mfxnghmuccevsxwcetej` | **RETAIL prod** | Customer books + **shared price tables** `securities_c`, `stock_intraday_c` (cents). **← corruption lives here.** MINT app reads/writes these. |
| `nnwzhxfjpjbzujevwzlh` | **INSTITUTIONAL prod** | MyMint desk trading book + desk analytics. Also `quote_snapshot_c` (dashboard overlay). |

MCP configured in `.mcp.json` as `supabase-retail` and `supabase-institutional` (both
`read_only=true` by default). Railway project = **MyMint** (`dacf9008-…`), service
**`Iress-Worker-PROD`** online.

---

## 2. Canonical unit — CONFIRMED cents (both systems)

- WN worker: `stock_intraday_c.current_price` / `securities_c.last_price` written in **cents**
  (`quoteToCents = last*100`; `quotes.ts`, `retail-ingest.ts`; README "current_price in cents").
- MINT app: `server/index.cjs:1274-1281` — reads `stock_intraday_c.current_price` and uses it
  directly as `expectedExitCents` ("Live price = client's expected exit, per-share, cents").

➡️ There is **no** cross-system unit disagreement in the schema. The bug is purely in how
the WRITE path decides the scale of an incoming IRESS value. Consumers do not need changing.

---

## 3. Root cause (exact code path)

### 3a. `chooseDisplayCents` — the disambiguator
`wealth-navigator/src/lib/iress/price-scale.ts:42`

```
asRands = round(lastRands * 100)   // treat incoming as Rands → cents
asCents = round(lastRands)         // treat incoming as already-cents
pick whichever is closer (log-distance) to referenceCents (= securities_c.last_price)
no reference (<=0) → return asRands  (×100)   ← SEED
```

Two defects:
- **Self-referential anchor.** `referenceCents` is `securities_c.last_price` — the very
  column the caller overwrites this same cycle (`quotes.ts:513`, `retail-ingest.ts:165`).
  A corrupt reference makes the corrupt candidate "win", locking in ×100 forever.
- **Unsafe no-reference default.** IRESS JSE equities arrive as **integer cents** (see
  `live.ts` `isStaleLastPriceOnlyRow`: "SOL LastPrice=17500 (cents)"; "cents-scale LastPrice
  > 4500"). Treating a missing reference as "must be Rands, ×100" is precisely wrong for the
  dominant JSE case and seeds the corruption.

### 3b. `resolveQuoteLast` does NOT fix scale
`wealth-navigator/src/lib/iress/live.ts:249` only rejects *outliers* within the quote's own
OHLC cluster (bogus `Last` vs `Close`/book mid). It returns the value in **whatever wire
scale it came in** — it never converts cents↔Rands. So scale is 100% on `chooseDisplayCents`.

### 3c. `withinWriteGuard` cannot catch it
`workers/iress-ingest/src/cutover.ts:40` → `computeDivergence(iressCents, refCents)` compares
to the same mutable `securities_c` reference. When the reference is already ×100, the ×100
tick is "within guard" and passes. The guard is anchored to the poison.

### 3d. Two writers to one column (the clash)
- **WN IRESS worker** (`Iress-Worker-PROD`, Railway) → `securities_c.last_price` + `stock_intraday_c`.
- **MINT `server/index.cjs`** (Yahoo cron, MINT-DEVELOPMENT repo) → same tables. Also the file
  the dev flagged for the YTD replay bug (already fixed, PR #175).
- Legacy note (AGENTS.md line 20): "identify existing ~15s writer of `mfxng…stock_intraday_c`
  before worker takeover" + Qentari Yahoo `docker-compose-pusher.yml` (`E:\Autonama\…\Qentari_Bravo_JSE`).

Whichever writes last sets the anchor scale for the other. Yahoo `.JO` values are already
cents; if any writer ever lands a Rands-scaled or unverified value, it poisons the anchor and
the other feed amplifies it.

---

## 4. Fix design (four parts)

### Part A — Break the circular anchor (code)
Add an **immutable trusted reference** that no tick loop overwrites, and disambiguate against
that, not the live `last_price`. Proposed change to `price-scale.ts` (backward compatible —
inert until a trusted ref is supplied):

```ts
export interface CentsChoice {
  cents: number;
  basis: "rands" | "cents-mislabeled" | "no-reference" | "empty" | "unverified";
  centsMultiplier: 1 | 100;
  scaleVerified: boolean; // NEW: true only when a reference actually disambiguated the scale
}

// NEW optional trustedRefCents (immutable, e.g. securities_c.scale_ref_cents).
// Prefer it over the mutable referenceCents so a corrupted last_price can no
// longer decide its own scale.
export function chooseDisplayCents(
  lastRands: number,
  referenceCents: number,
  trustedRefCents = 0,
): CentsChoice {
  if (!Number.isFinite(lastRands) || lastRands <= 0)
    return { cents: 0, basis: "empty", centsMultiplier: 100, scaleVerified: false };

  const ref = trustedRefCents > 0 ? trustedRefCents : referenceCents; // trusted wins
  const asRands = Math.round(lastRands * 100);

  if (!Number.isFinite(ref) || ref <= 0)
    // FAIL-SAFE: no anchor → do NOT guess ×100. Report unverified; money-track
    // callers must SKIP the write (leave last good / Yahoo value untouched).
    return { cents: asRands, basis: "unverified", centsMultiplier: 100, scaleVerified: false };

  const asCents = Math.round(lastRands);
  const dist = (c: number) => Math.abs(Math.log(c / ref));
  if (asCents > 0 && dist(asCents) < dist(asRands))
    return { cents: asCents, basis: "cents-mislabeled", centsMultiplier: 1, scaleVerified: true };
  return { cents: asRands, basis: "rands", centsMultiplier: 100, scaleVerified: true };
}
```

Then in `quotes.ts` and `retail-ingest.ts`, at the money-track write:
```ts
const choice = chooseDisplayCents(quote.last, ref?.lastPriceCents ?? 0, ref?.scaleRefCents ?? 0);
if (!choice.scaleVerified) { /* skip money-track write; log "scale_unverified"; keep prior value */ continue; }
```
`quote_snapshot_c` / chart overlays may still display an unverified value **with a caveat**,
but the money track (client portfolios) must never take an unverified scale.

> ⚠️ Behaviour change: symbols with no trusted/last reference stop writing until anchored.
> That is the safe direction (a stale-but-correct price beats a fresh ×100 one). Quantify how
> many symbols this affects in the live check (§5) before deploy.

### Part B — Immutable trusted reference (migration, review-only, user-pasted)
```sql
-- RETAIL prod (mfxnghmuccevsxwcetej) — additive, no data touched.
alter table public.securities_c add column if not exists scale_ref_cents bigint;
comment on column public.securities_c.scale_ref_cents is
  'Immutable, human-verified price magnitude (cents) used ONLY to disambiguate IRESS cents/Rands scale. NEVER written by a tick loop.';
```
Populate **once** from verified-correct values (post-correction §D, or a trusted Yahoo/close
snapshot). Worker reads it; never writes it. Add `SCALE_REF=1`-style gate if desired.

### Part C — One authoritative money-track writer
Per Juan's call: retire Yahoo as a **live writer**; IRESS is the source of truth. Yahoo stays
as **fallback only**.
- Stop MINT `server/index.cjs` (and the Qentari pusher) from writing `securities_c.last_price`
  / `stock_intraday_c` once IRESS coverage is confirmed. Confirm which is the ~15s writer first.
- Keep `price_source` (`securities_c.price_source`, migration `supabase/retail/20260614_add_price_source.sql`)
  populated (`RETAIL_PRICE_SOURCE_COL=1`) so every row is attributable.
- **Yahoo-fallback safety:** if IRESS is unavailable and the system falls back to Yahoo, the
  fallback path must stamp `price_source='yahoo'` and write **deterministic cents** (Yahoo
  `.JO` is already cents — write verbatim, do NOT ×100). Never route Yahoo through the
  Rands-guess branch. A fallback write must also require `scaleVerified` against `scale_ref_cents`.

### Part D — Correct the already-×100 rows (SQL runbook)
See `wealth-navigator/scratch/price-scale-correction.sql`. Snapshot FIRST, detect, review,
then guarded `÷100` inside a transaction, verify against ground truth (NOT by recalculating).

---

## 5. Live-DB verification runbook (run when MCP connected)

Run these read-only on **supabase-retail** first. Do not write anything until §D snapshot done.

1. **Confirm corruption + scale of it**
   ```sql
   select s.symbol, s.last_price, s.prev_close, s.price_source,
          round(s.last_price::numeric / nullif(s.prev_close,0), 2) as ratio
   from securities_c s
   where s.last_price is not null
   order by s.last_price desc
   limit 50;
   ```
   Look for `ratio ≈ 100` (or ≈ 0.01) and implausibly large `last_price`
   (ordinary JSE single names rarely exceed ~500,000c = R5,000).

2. **When did it jump?** (find the ×100 step in intraday history)
   ```sql
   select security_id, timestamp, current_price
   from stock_intraday_c
   where security_id = '<suspect id>'
   order by timestamp desc limit 100;
   ```

3. **Attribution** — group by `price_source`; is it IRESS rows, Yahoo rows, or both?
4. **Coverage impact of Part A** — how many symbols have `last_price` null/0 (would become
   "unverified → skip")? `select count(*) from securities_c where coalesce(last_price,0)=0;`
5. **Who is the ~15s writer?** Check `integration_worker_health`, Railway logs for
   `Iress-Worker-PROD`, and whether MINT `server/index.cjs` cron is still writing prices.
6. **Client "set-in-stone" fields** (Lonwabo): locate the cost-basis / average fields
   (`client_strategy_returns_c`, holdings avg cost, `oems_order_audit` fills). Export to an
   out-of-app spreadsheet BEFORE any correction. These must never be touched by a price fix.
7. **Strategy chain integrity** (dev point #1/#2): after any price correction, check the
   latest `strategy_return_publication_audit_c` row: `checks.chain_reconciled = true`, and
   `yesterday.chain_factor × (1 + today.1d_pct) == today.chain_factor`. If not, stop — do not
   republish; trace it (a corrupt price feeds the guarded publisher).

---

## 6. Hard safety constraints (from the call + dev brief)

- **Snapshot before any write.** Keep today's ending Supabase snapshot; the team also wants a
  spreadsheet of client average/cost-basis fields OUTSIDE the app.
- **Never touch** client documents, KYC, wallets, holdings quantities, cost basis. Price fix is
  `securities_c` / `stock_intraday_c` only.
- **Do NOT "fix" a weird number by recalculating it.** Trust the already-validated guarded row;
  verify against independent ground truth (actual Yahoo/IRESS close, transaction records).
- **DB is on Micro tier at ~99.7% CPU** (dev point #4). Consider the Supabase compute upgrade
  BEFORE enabling full-universe IRESS writes, or the migration may tip it over.
- **Migrations are review-only** — worker never applies DDL; operator pastes SQL.
- **UAT vs prod isolation** — never let CT/UAT (`webservices-ct`) prices reach the money track;
  the retail write is fail-closed on `isUatEnv()`.

---

## 7. Session state / what's done

- `.mcp.json` created (retail + institutional, read-only). Auth cached; a **fresh** session in
  this repo picks up the tools at startup.
- This doc + `scratch/price-scale-correction.sql` written. Code fix (§4A) specified as a diff —
  **not yet applied** to `price-scale.ts` / `quotes.ts` / `retail-ingest.ts` pending live
  verification of coverage impact (§5.4).
- Nothing deployed. Railway worker untouched.

**Next action when connected:** run §5.1–5.6 read-only → confirm the correction scope →
snapshot → apply §D correction in a transaction → apply §4A+B code+migration → shadow-run the
worker (`IRESS_RETAIL_DRY_RUN=1`) → verify §5.7 → then flip to live writes.
