# MINT "×100" Inflated P&L — Step-by-Step Fix Runbook

**Read this fully before we touch anything.** Reviewed together, executed slowly.

## Plain-English summary (what is really wrong)

- The **database is correct**. Prices and holdings are stored in **cents** and are right
  (verified: AGL R830.88, holdings `market_value = quantity × price` exactly).
- The inflated client P&L (Lonwabo R128k value ≈ R126k "profit") is produced by the
  **admin Client Studio code** when it *reads* the data — file
  `wealth-navigator/src/app/api/admin/studio/route.ts`, line 45.
- Cause: holdings with **no recorded fill price** (`avg_fill` empty) are given a
  **cost of 0**, so their whole market value is shown as profit. Plus a fragile
  cents-vs-Rands guess on `Expected_fill` that can be 100× off.
- ➡️ **Editing prices in the DB will never fix this.** The fix is in the app code.

## Ground rules (safety)

1. I (Claude) run **read-only** queries only. **You** run every write, after review.
2. We do **DEV / preview first**, verify, then **LIVE**.
3. We change **no client rows**. Step 1 = read-only. Step 2 = add an index (no data
   change). Step 3 = app code (no DB change).
4. If anything looks wrong at any step, **stop** and tell me — do not "fix by editing values".

## Which project / where

- Supabase project = **RETAIL prod**, ref **`mfxnghmuccevsxwcetej`** (the MINT app DB).
- Supabase Dashboard → pick that project → **SQL Editor** (left sidebar) → **+ New query**
  → paste → **Run** (Ctrl/Cmd + Enter).

---

## STEP 0 — Safety snapshot (you, ~2 min) — precautionary only

1. Supabase Dashboard → project `mfxnghmuccevsxwcetej` → **Database** → **Backups**.
2. Note the timestamp of the latest daily backup (write it down). If a "Restore" /
   PITR option exists, that's our undo. We will **not** need it (no client data changes),
   but we note it before starting.

---

## STEP 1 — PROVE the cause (read-only, 100% safe)

Paste each block in the SQL Editor and Run. Nothing is written.

### 1a — Look at one client's holdings (uses Lonwabo from your screenshot)

```sql
select
  s.symbol,
  h.quantity,
  h.avg_fill                                   as avg_fill_cents,   -- cost/share, CENTS (empty = no cost)
  h."Expected_fill"                            as expected_cents,   -- quoted cost/share
  s.last_price                                 as price_cents,      -- current price, CENTS
  round((h.quantity * s.last_price / 100.0)::numeric, 2) as market_value_rands,
  (coalesce(h.avg_fill,0) = 0 and coalesce(h."Expected_fill",0) = 0) as no_cost_recorded
from stock_holdings_c h
join securities_c s on s.id = h.security_id
join profiles     p on p.id = h.user_id
where p.email = 'lonwabodamane@gmail.com'
  and h.is_active = true
  and h.trade_side = 'BUY';
```

**What we expect to see:** most rows with `no_cost_recorded = true` (empty `avg_fill`
and `Expected_fill`). Those are the ones the app currently reports as pure profit.

### 1b — The whole-portfolio proof (one number)

```sql
select
  count(*)                                                                   as holdings,
  count(*) filter (where coalesce(h.avg_fill,0)=0 and coalesce(h."Expected_fill",0)=0) as no_cost_holdings,
  round(sum(h.quantity * s.last_price / 100.0)::numeric, 2)                  as total_value_rands,
  round(sum(case when coalesce(h.avg_fill,0)=0 and coalesce(h."Expected_fill",0)=0
                 then h.quantity * s.last_price / 100.0 else 0 end)::numeric, 2) as value_with_no_cost_rands
from stock_holdings_c h
join securities_c s on s.id = h.security_id
join profiles     p on p.id = h.user_id
where p.email = 'lonwabodamane@gmail.com'
  and h.is_active = true and h.trade_side = 'BUY';
```

**Confirmation:** if `value_with_no_cost_rands` ≈ `total_value_rands`, the inflation is
100% explained (almost all value has no cost → shown as profit). Repeat for
`asisiphodamane@gmail.com` to double-confirm.

### 1c — Resolve the `Expected_fill` scale (so the code fix is exact)

```sql
select
  count(*)                                                              as rows_with_both,
  round(percentile_cont(0.5) within group (
        order by h."Expected_fill" / nullif(h.avg_fill,0))::numeric, 4) as median_expected_over_avg
from stock_holdings_c h
where coalesce(h.avg_fill,0) > 0 and coalesce(h."Expected_fill",0) > 0;
```

**How to read:** `median_expected_over_avg` ≈ **1** → `Expected_fill` is in **cents**
(same as `avg_fill`). ≈ **0.01** → it's in **Rands**. (The code fix in Step 3 is written
to handle either safely, but this tells us for certain.)

> ✅ **Checkpoint:** send me the outputs of 1a/1b/1c. If they match the expectation, we
> proceed. If a client is inflated but their holdings *do* have cost recorded, we STOP —
> that would mean a different cause and I re-investigate before any change.

---

## STEP 2 — Fix the slowness / timeouts (add one index; safe + online)

Your busiest query (latest tick per security) is ~29% of all DB time and times out
because `stock_intraday_c.security_id` has **no index**. This is additive and reversible.

Run this **alone** (paste nothing else with it) in the SQL Editor:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_intraday_sec_ts
  ON public.stock_intraday_c (security_id, "timestamp" DESC);
```

- `CONCURRENTLY` = builds without locking writes (safe during the day). It **cannot** run
  together with other statements — run it by itself.
- If you get `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`,
  tell me — we'll either run the non-concurrent version in a quiet window or use the
  Dashboard → Database → Indexes UI.

**Verify it exists:**

```sql
select indexname from pg_indexes
where schemaname='public' and tablename='stock_intraday_c';
```
(expect `idx_stock_intraday_sec_ts` in the list)

**Rollback if ever needed:**
```sql
DROP INDEX CONCURRENTLY IF EXISTS public.idx_stock_intraday_sec_ts;
```

(After this works, I'll give you the same one-liners for `stock_returns_c.security_id`
and `stock_holdings_c.security_id`.)

---

## STEP 3 — Fix the real bug (admin Client Studio code — no DB change)

File: `wealth-navigator/src/app/api/admin/studio/route.ts` (the code behind
`my-mint-admin` → "Client Breakdown").

### 3a — The exact change (I apply with your OK)

**FIND** this (currently line 45, the `const holdings = ...` mapping):

```ts
const holdings=(holds??[]).map(h=>{const security=secMap[String(h.security_id)],quantity=Number(h.quantity)||0,avgRands=(Number(h.avg_fill)||0)/100,expected=Number(h.Expected_fill)||0,lastPrice=Number(security?.last_price)||0,cost=expected>0?(avgRands>0&&expected>avgRands*5?expected/100:expected):avgRands,live=intradayMap.get(String(h.security_id))??(lastPrice>0?lastPrice/100:cost),marketValue=quantity*live,costTotal=quantity*cost;return{id:h.id,symbol:security?.symbol??"—",name:security?.name??security?.symbol??"—",logo_url:security?.logo_url??null,quantity,cost,live,marketValue,pnl:marketValue-costTotal,pnlPct:costTotal>0?((marketValue-costTotal)/costTotal)*100:0,pending:!(Number(h.avg_fill)>0),strategyId:h.strategy_id,strategy:h.strategy_name_snapshot??null}}).sort((a,b)=>b.marketValue-a.marketValue);
```

**REPLACE** with this (same logic, corrected cost basis):

```ts
const holdings = (holds ?? []).map(h => {
  const security = secMap[String(h.security_id)];
  const quantity = Number(h.quantity) || 0;
  const lastPriceCents = Number(security?.last_price) || 0;

  // LIVE price in Rands. intradayMap is already /100 (Rands); fall back to last_price/100.
  const live = intradayMap.get(String(h.security_id)) ?? (lastPriceCents > 0 ? lastPriceCents / 100 : 0);

  // COST basis in Rands. All money columns are CENTS. Prefer Expected_fill (client
  // quoted price) over avg_fill (broker fill), per desk convention. Anchor
  // Expected_fill's scale to the live cents price so a stray Rands-scaled value can't
  // throw cost off by 100x (replaces the old `expected > avgRands*5` guess).
  const avgFillCents = Number(h.avg_fill) || 0;
  let expectedCents = Number(h.Expected_fill) || 0;
  if (expectedCents > 0 && lastPriceCents > 0 && expectedCents < lastPriceCents / 20) {
    expectedCents = expectedCents * 100; // stored in Rands -> normalise to cents
  }
  const hasCost = expectedCents > 0 || avgFillCents > 0;
  const costCents = expectedCents > 0 ? expectedCents : avgFillCents;

  // THE FIX: a holding with NO recorded cost is valued at cost = live, so it shows
  // pnl 0 instead of its entire market value as fake profit.
  const cost = hasCost ? costCents / 100 : live;

  const marketValue = quantity * live;
  const costTotal   = quantity * cost;
  return {
    id: h.id,
    symbol: security?.symbol ?? "—",
    name: security?.name ?? security?.symbol ?? "—",
    logo_url: security?.logo_url ?? null,
    quantity, cost, live, marketValue,
    pnl: marketValue - costTotal,
    pnlPct: costTotal > 0 ? ((marketValue - costTotal) / costTotal) * 100 : 0,
    pending: !hasCost,
    strategyId: h.strategy_id,
    strategy: h.strategy_name_snapshot ?? null,
  };
}).sort((a, b) => b.marketValue - a.marketValue);
```

Nothing else in the file changes. This only changes how numbers are **calculated for
display** — it writes nothing to the database.

### 3b — Deploy DEV/preview first, then verify, then live

1. I apply the edit above (on your go-ahead).
2. Deploy a **preview** build of the Wealth Navigator app (Vercel preview URL — not
   production yet).
3. Open the preview admin → Client Studio → Lonwabo and Asisipho. Expect:
   - Portfolio value ≈ the same sensible number.
   - **P&L now realistic** (small vs value), not ≈ 100% of value.
4. Only when that looks right do we deploy to **production**.

---

## STEP 4 — Final verification (after live deploy)

- Open the two clients in the live admin. P&L should be sane.
- Because nothing was written to the DB, if the numbers ever look wrong we just adjust
  the code and redeploy — no data to "put back".

---

## What we are deliberately NOT doing now

- ❌ Not editing prices in the DB (they're correct).
- ❌ Not touching any client/holdings/KYC/wallet rows.
- ❌ Not enabling RLS / changing security on live tables tonight (that can break the app —
  it's staged for a planned window, see below).

## Bigger list — staged for later (I'll bring reviewed SQL/diffs for each)

1. **Security hardening** (from your lint export): RLS is off on `wallets` and financial
   tables; `transfer_parent_to_child_wallet` + `secure_pledge_liquidity_v1` are callable
   by anonymous users; 4 SECURITY DEFINER views; `documents` bucket allows listing.
   These are real but require add-policies-then-test — DEV first, live in a maintenance window.
2. **IRESS → Yahoo migration safety** (already coded, not deployed): immutable price
   anchor + skip-unverified so IRESS-primary/Yahoo-fallback can never inflate. Separate
   from this incident; do after the above is stable.
3. **More perf**: remaining unindexed FKs, ~40 unused indexes, add PK to
   `strategy_rebalance_residuals`.

---

### The only decision I need from you to start

Reply **"go step 1"** and either you run the Step 1 queries, or say the word and I run
them read-only and paste the results. We do not move to Step 2 until Step 1 confirms the cause.
