-- ============================================================================
-- A5 — DIAGNOSIS: OPEN SYMBOLS (READ-ONLY)
-- ----------------------------------------------------------------------------
-- Companion: docs/PRICE_FIX_2026-07-28_B/README_B.md
--
-- Purpose: investigate the 4 symbols that the Track A pack deliberately did
--          NOT patch (BHG, NPN, PRX, SOL). For each, answer:
--            (1) Is the value actually wrong, or just stale?
--            (2) Is there unit-mismatch (ZAR vs ZAc) — per
--                .agents/memory/yahoo-jse-price-units.md playbook?
--            (3) Is Yahoo corroboration meaningful given the 24h staleness?
--
-- Unlike A1 (Track A pack), this script adds:
--   - Yahoo staleness column (so you can see when Yahoo last verified)
--   - Stock_intraday_c flat-lock check (the BHG pattern: same value repeating)
--   - JSE ground-truth band check (only the symbols that have a meaningful band)
--
-- NO writes. Paste into Supabase SQL editor on RETAIL prod (mfxnghmuccevsxwcetej).
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ A5.1 — Per-symbol cross-source + staleness + JSE band
-- └──────────────────────────────────────────────────────────────────────────
-- For BHG / NPN / PRX / SOL, show:
--   - The current securities_c.last_price (what the UI shows)
--   - IRESS live from quote_snapshot_c (freshest source)
--   - Yahoo from iress_price_validation_c (24h stale, last_checked shows when)
--   - IRESS↔Yahoo divergence %, with a staleness flag
--   - JSE official band (where known) — IN-BAND or OUT-OF-BAND
--   - Stock_intraday_c flat-lock indicator (BHG pattern detector)

with target_symbols(symbol) as (
  values ('BHG'),('NPN'),('PRX'),('SOL')
),
joined as (
  select
    t.symbol,
    s.last_price                   as sc_cents,
    qs.last                        as iress_cents_live,
    qs.as_of                       as iress_as_of,
    round(extract(epoch from (now() - qs.as_of)) / 60, 1)         as iress_age_min,
    iv.last_yahoo_cents            as yahoo_cents,
    iv.last_iress_cents            as iv_iress_cents_at_last_check,
    iv.last_checked                as yahoo_last_checked,
    round(extract(epoch from (now() - iv.last_checked)) / 60, 1)   as yahoo_age_min,
    iv.samples_total,
    iv.samples_ok,
    case
      when iv.last_yahoo_cents is null then null
      else round(((qs.last - iv.last_yahoo_cents)::numeric / iv.last_yahoo_cents) * 100, 3)
    end                            as iress_vs_yahoo_pct_now,
    case
      when iv.last_iress_cents is null or iv.last_yahoo_cents is null then null
      else round(((iv.last_iress_cents - iv.last_yahoo_cents)::numeric / iv.last_yahoo_cents) * 100, 3)
    end                            as iress_vs_yahoo_pct_at_last_check,
    case
      when s.last_price is null or qs.last is null then null
      else round(((s.last_price - qs.last)::numeric / qs.last) * 100, 3)
    end                            as sc_vs_iress_pct
  from target_symbols t
  left join public.securities_c s                on s.symbol = t.symbol
  left join public.quote_snapshot_c qs           on qs.security_code = t.symbol
  left join public.iress_price_validation_c iv   on iv.symbol = t.symbol
)
select
  symbol,
  sc_cents,
  round(sc_cents / 100.0, 2) as sc_rands,
  iress_cents_live,
  round(iress_cents_live / 100.0, 2) as iress_rands,
  iress_age_min,
  yahoo_cents,
  round(yahoo_cents / 100.0, 2) as yahoo_rands,
  yahoo_age_min,
  yahoo_last_checked,
  iress_vs_yahoo_pct_now,
  iress_vs_yahoo_pct_at_last_check,
  samples_total,
  samples_ok,
  sc_vs_iress_pct,
  case symbol
    when 'NPN' then '[78000, 90000]'
    when 'PRX' then '[67000, 76000]'
    when 'SOL' then '[17000, 19500]'
    when 'BHG' then '[65521, 70551]'    -- JSE band BHG 2026-07-22 close 69,447c; today ~70,551c
  end as jse_official_band_cents,
  case symbol
    when 'NPN' then sc_cents between 78000 and 90000
    when 'PRX' then sc_cents between 67000 and 76000
    when 'SOL' then sc_cents between 17000 and 19500
    when 'BHG' then sc_cents between 65521 and 70551
  end as sc_in_jse_band,
  case symbol
    when 'NPN' then iress_cents_live between 78000 and 90000
    when 'PRX' then iress_cents_live between 67000 and 76000
    when 'SOL' then iress_cents_live between 17000 and 19500
    when 'BHG' then iress_cents_live between 65521 and 70551
  end as iress_in_jse_band
from joined
order by symbol;


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ A5.2 — Stock_intraday_c flat-lock detector (the BHG pattern)
-- └──────────────────────────────────────────────────────────────────────────
-- If a writer keeps writing the same constant value to stock_intraday_c for
-- many ticks, the UI may be displaying a frozen value. This block counts
-- distinct current_price values per symbol in the past 14 days.

select s.symbol,
       count(*) as total_ticks_14d,
       count(distinct i.current_price) as distinct_prices_14d,
       max(i.current_price) as max_p,
       min(i.current_price) as min_p,
       case
         when count(*) = 0 then 'NO_DATA'
         when count(*) = count(distinct i.current_price) then 'VARIETY_OK'
         when count(distinct i.current_price) <= 3 then 'FLAT_LOCKED'
         else 'LIMITED_VARIETY'
       end as variety_flag,
       max(i.timestamp) as last_tick,
       round(extract(epoch from (now() - max(i.timestamp))) / 60, 1) as last_tick_age_min
from public.securities_c s
left join public.stock_intraday_c i on i.security_id = s.id
   and i.timestamp > now() - interval '14 days'
where s.symbol in ('BHG','NPN','PRX','SOL')
group by s.symbol
order by s.symbol;


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ A5.3 — "BHG is BHP, not Brait" — symbol identity check
-- └──────────────────────────────────────────────────────────────────────────
-- Per the ground-truth search:
--   BHG on JSE = BHP Group Limited (AU000000BHP4), dual-listed.
--   Brait PLC trades as BAT on JSE.
-- This check confirms the securities_c.symbol='BHG' is actually pointing at
-- the right ISIN — important if the BHG number turns out to be ZAc × 100
-- (i.e., a writer mistakenly stored Rand-amount × 100 → wrong unit).

select id, symbol, name, sector, last_price, prev_close
from public.securities_c
where symbol = 'BHG' or name ilike '%brait%' or name ilike '%bhp%';


-- ┌──────────────────────────────────────────────────────────────────────────
-- │ A5.4 — IRESS fresh re-poll check (read-only)
-- └──────────────────────────────────────────────────────────────────────────
-- Show every quote_snapshot_c row written in the past 2 hours for the 4
-- symbols, in case the IRESS writer fires mid-session.

select security_code, last, prev_close, high, low, volume, as_of,
       round(extract(epoch from (now() - as_of)) / 60, 1) as age_min
from public.quote_snapshot_c
where security_code in ('BHG','NPN','PRX','SOL')
  and as_of > now() - interval '2 hours'
order by security_code, as_of desc;
