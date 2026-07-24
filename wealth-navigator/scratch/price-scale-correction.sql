-- ============================================================================
-- IRESS ×100 PRICE-SCALE CORRECTION — RETAIL prod (mfxnghmuccevsxwcetej)
-- ----------------------------------------------------------------------------
-- REVIEW-ONLY RUNBOOK. Do NOT paste this file wholesale. Run block by block,
-- read the output, and only proceed to the guarded UPDATE after a human has
-- confirmed the suspect list. Touches ONLY price tables (securities_c,
-- stock_intraday_c) — NEVER customer/KYC/holdings/cost-basis tables.
--
-- Companion: wealth-navigator/docs/IRESS_PRICE_SCALE_INCIDENT_HANDOFF.md
-- Canonical unit for these columns is CENTS (confirmed both WN + MINT).
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 0 — SNAPSHOT FIRST (do NOT skip). Two independent backups.
-- └──────────────────────────────────────────────────────────────────────────
-- 0a. Supabase Dashboard → Database → Backups: confirm today's daily snapshot
--     exists, OR take a manual one. This is the whole-DB rollback.
--
-- 0b. Point-in-time price backup INSIDE the DB (cheap, no extra project):
create table if not exists _price_backup_20260724 as
  select id, symbol, last_price, prev_close,
         (now() at time zone 'utc') as backed_up_at
  from public.securities_c;
--     Verify: select count(*) from _price_backup_20260724;
--
-- 0c. Client "set-in-stone" fields (Lonwabo) — EXPORT OUTSIDE THE APP to a
--     spreadsheet before any change. These are NOT corrected here; this is
--     only to prove they were untouched. Adjust table/column names to reality
--     (verify against live schema first):
--        select * from client_strategy_returns_c;      -- AUM / returns basis
--        -- holdings avg cost / cost basis table (name TBD from live schema)
--        -- oems_order_audit fills (avg_fill_price / expected fill)


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 1 — DETECT suspect ×100 rows (READ-ONLY). Review the output by hand.
-- └──────────────────────────────────────────────────────────────────────────
-- Heuristic signals (no single one is proof — a human confirms):
--   (a) last_price / prev_close ≈ 100  (ratio 90–110)  → last_price is ×100 high
--   (b) last_price / prev_close ≈ 0.01 (ratio 0.009–0.011) → last_price is ×100 low
--   (c) implausible magnitude for an ordinary JSE single name (> ~5,000,000c = R50,000)
select
  s.id, s.symbol, s.last_price, s.prev_close, s.price_source,
  round(s.last_price::numeric / nullif(s.prev_close, 0), 3) as last_over_prev,
  case
    when s.prev_close > 0 and s.last_price::numeric / s.prev_close between 90 and 110  then 'x100_HIGH'
    when s.prev_close > 0 and s.last_price::numeric / s.prev_close between 0.009 and 0.011 then 'x100_LOW'
    when s.last_price > 5000000 then 'IMPLAUSIBLE_HIGH'
    else 'ok?'
  end as verdict
from public.securities_c s
where s.last_price is not null
order by verdict, s.last_price desc;

-- Cross-check against ground truth for a handful of names before trusting the
-- heuristic: compare last_price to the ACTUAL Yahoo/IRESS close you can verify
-- externally (do NOT recalculate from other app numbers — dev brief point #9).


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 2 — DRY-RUN the correction (READ-ONLY preview of the exact change).
-- └──────────────────────────────────────────────────────────────────────────
-- Edit the symbol list to EXACTLY the rows a human confirmed in Step 1.
-- This SELECT shows what the UPDATE would do — nothing is written.
with targets as (
  select id, symbol, last_price,
         (last_price / 100)::bigint as corrected_last_price
  from public.securities_c
  where symbol = any (array[
    -- 'SOL','AGL','NPN', ...   ← fill with CONFIRMED ×100-high symbols only
  ]::text[])
)
select * from targets order by symbol;


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 3 — GUARDED CORRECTION (transaction). Review inside the txn, then COMMIT.
-- └──────────────────────────────────────────────────────────────────────────
-- Correct ONLY the confirmed symbols. Wrapped so you can ROLLBACK if the
-- post-update check looks wrong. Adjust the divisor per verdict:
--   x100_HIGH → last_price / 100 ;  x100_LOW → last_price * 100.
begin;

  update public.securities_c
  set last_price = (last_price / 100)::bigint
  where symbol = any (array[
    -- 'SOL','AGL','NPN', ...   ← SAME confirmed list as Step 2
  ]::text[])
    and last_price > 5000000;          -- extra safety: only obviously-inflated rows

  -- Post-update check INSIDE the transaction (verify BEFORE commit):
  select s.symbol, b.last_price as before, s.last_price as after, s.prev_close
  from public.securities_c s
  join _price_backup_20260724 b on b.id = s.id
  where s.last_price <> b.last_price
  order by s.symbol;

-- If the "after" column now sits sensibly next to prev_close → COMMIT.
-- If anything looks off → ROLLBACK and re-check Step 1.
-- commit;
-- rollback;


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 4 — Optional: clean stale ×100 intraday ticks so the next sync repops.
-- └──────────────────────────────────────────────────────────────────────────
-- (Mirrors the worker README's stale-row cleanup. Deleting ticks is safe —
-- market prices are recoverable; the next IRESS poll repopulates fresh rows.)
-- Restrict to the corrected symbols + only obviously-inflated ticks.
-- delete from public.stock_intraday_c i
-- using public.securities_c s
-- where i.security_id = s.id
--   and s.symbol = any (array[ /* confirmed list */ ]::text[])
--   and i.current_price > 5000000;


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 5 — Seed the immutable scale reference (after correction is verified).
-- └──────────────────────────────────────────────────────────────────────────
-- Requires the additive migration (see handoff §4B):
--   alter table public.securities_c add column if not exists scale_ref_cents bigint;
-- Populate ONCE from the now-correct values so the worker can disambiguate
-- scale WITHOUT anchoring to the mutable last_price. Never written by a tick loop.
-- update public.securities_c
--   set scale_ref_cents = last_price
--   where last_price is not null and scale_ref_cents is null;


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ STEP 6 — Strategy chain integrity check (dev brief #1/#2). READ-ONLY.
-- └──────────────────────────────────────────────────────────────────────────
-- After prices are correct, confirm the guarded publisher still reconciles.
-- If chain_reconciled = false or the math below doesn't multiply out, STOP and
-- trace — do NOT republish.
select strategy_id, as_of_date,
       (checks->>'chain_reconciled')::bool as chain_reconciled,
       chain_factor, ytd_pct, one_d_pct
from public.strategy_return_publication_audit_c   -- verify table/column names live
order by as_of_date desc
limit 20;
-- Manual: yesterday.chain_factor * (1 + today.one_d_pct/100) ≈ today.chain_factor ?

-- ============================================================================
-- CLEANUP (after everything is verified and stable for a day or two):
--   drop table if exists _price_backup_20260724;
-- ============================================================================
