-- IMPORTANT: the slug on disk is 'jse_alpha', not 'qentari_bravo_jse'
-- (display name = "Qentari Bravo JSE", strategy_name = "Qentari Bravo JSE").

-- 2) Metric snapshots — drives "Demo Account" KPIs (Starting Capital, etc.)
select kind, label, as_of, budget, final_equity, total_return,
       max_drawdown, start_date, end_date, sharpe, cagr, fees_bps
from model_metric_c
where model_slug = 'jse_alpha'
order by as_of desc
limit 30;

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

-- 8) Registry row the benchmark route looks up (no `benchmark` col on the table)
select slug, currency, name, status, mode, budget
from model_registry_c
where slug = 'jse_alpha';