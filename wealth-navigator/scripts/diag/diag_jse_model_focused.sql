-- IMPORTANT: the slug on disk is 'jse_alpha', not 'qentari_bravo_jse'
-- (display name = "Qentari Bravo JSE", strategy_name = "Qentari Bravo JSE").
--
-- Skip block 2 (model_metric_c) — that table isn't in the institutional DB
-- yet (only model_equity_point_c + model_registry_c are). The dashboard
-- already derives Starting Capital / Current Value / Max Drawdown from the
-- equity curve, so we don't need model_metric_c to answer the drawdown
-- question.

-- 3) Equity curve breakdown by kind/label
select kind, label, count(*) as points,
       min(ts) as first_ts, max(ts) as last_ts,
       min(equity) as min_eq, max(equity) as max_eq
from model_equity_point_c
where model_slug = 'jse_alpha'
group by kind, label
order by kind, label;

-- 3b) Last 12 raw equity rows
select kind, label, ts, equity, cash, day_pnl, day_pnl_pct
from model_equity_point_c
where model_slug = 'jse_alpha'
order by ts desc
limit 12;

-- 3c) Drawdown verification — recomputes max drawdown in pure SQL on the
--     same paper curve the dashboard reads, and lists the 10 deepest troughs
--     so we can see if intraday dips actually exist (and at what magnitude).
--     Compare `max_drawdown_pct` here to the dashboard's "Max Drawdown" KPI
--     to confirm the UI math matches the data.
with paper as (
  select ts, equity,
         max(equity) over (order by ts rows between unbounded preceding and current row) as peak_so_far
  from model_equity_point_c
  where model_slug = 'jse_alpha'
    and kind in ('paper', 'live')
    and equity is not null
)
select 'summary' as kind,
       count(*) as points,
       min(equity) as min_equity,
       max(equity) as max_equity,
       max(peak_so_far) as final_peak,
       min(case when peak_so_far > 0 then equity / peak_so_far - 1 end) as max_drawdown,
       min(case when peak_so_far > 0 then equity / peak_so_far - 1 end) * 100 as max_drawdown_pct
from paper;

-- 3d) Worst 10 troughs (most negative drawdown points) — confirms whether
--     dips exist or the curve is genuinely monotonic-up.
--     Cast to ::numeric so round(numeric, int) matches (pg has no
--     round(double precision, integer)).
with paper as (
  select ts, equity,
         max(equity) over (order by ts rows between unbounded preceding and current row) as peak_so_far
  from model_equity_point_c
  where model_slug = 'jse_alpha'
    and kind in ('paper', 'live')
    and equity is not null
)
select ts,
       equity,
       peak_so_far,
       round(((equity / peak_so_far - 1) * 100)::numeric, 4) as drawdown_pct
from paper
order by (equity / peak_so_far - 1) asc
limit 10;

-- 8) Registry row the benchmark route looks up (no `benchmark` col on the table).
--    Guarded with to_regclass so a missing table doesn't kill the probe.
do $$
begin
  if to_regclass('model_registry_c') is null then
    raise notice 'model_registry_c not present in this DB — skipping block 8.';
    return;
  end if;
end $$;

select slug, currency, name, status, mode, budget
from model_registry_c
where slug = 'jse_alpha';