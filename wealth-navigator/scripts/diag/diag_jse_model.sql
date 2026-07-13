-- ============================================================
-- JSE model diagnostic for nnwzhxfjpjbzujevwzlh (institutional)
-- Paste each block into the Supabase SQL editor in order.
-- ============================================================

-- 0) Confirm we're on the right project + tables exist
select current_database() as db, current_user as "role", now() as run_at;

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'model_registry_c','model_metric_c','model_equity_point_c',
    'model_prediction_c','model_position_c','model_trade_c','model_run_c'
  )
order by table_name;

-- 0b) Confirm the missing-column bug that breaks /api/models/[id]/benchmark
--     (the BFF selects `benchmark` which does not exist on model_registry_c)
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'model_registry_c'
order by ordinal_position;

-- 1) Registered models
select slug, name, strategy_name, mode, status, market, data_source,
       currency, budget, last_heartbeat_at, last_run_at, created_at
from model_registry_c
order by created_at asc;

-- 2) Metric snapshots — drives "Demo Account" KPIs (Starting Capital, etc.)
select kind, label, as_of, budget, final_equity, total_return,
       max_drawdown, start_date, end_date, sharpe, cagr, fees_bps
from model_metric_c
where model_slug = 'qentari_bravo_jse'
order by as_of desc
limit 30;

-- 3) Equity curve breakdown — paper/live for the daily chart, backtest for the backtest chart
select kind, label, count(*) as points,
       min(ts) as first_ts, max(ts) as last_ts,
       min(equity) as min_eq, max(equity) as max_eq
from model_equity_point_c
where model_slug = 'qentari_bravo_jse'
group by kind, label
order by kind, label;

-- 3b) Last 12 raw equity rows — confirms the pusher is actually writing numeric equity
select kind, label, ts, equity, cash, day_pnl, day_pnl_pct
from model_equity_point_c
where model_slug = 'qentari_bravo_jse'
order by ts desc
limit 12;

-- 4) Latest position snapshot (Current Holdings)
select snapshot_at, symbol, side, qty, avg_entry_price, market_value,
       unrealized_pl, unrealized_plpc, weight
from model_position_c
where model_slug = 'qentari_bravo_jse'
order by snapshot_at desc
limit 20;

-- 5) Latest predictions (Next Rebalance Target)
select predicted_at, symbol, side, quantity, expected_entry_price,
       ml_prob_up, score, reason
from model_prediction_c
where model_slug = 'qentari_bravo_jse'
order by predicted_at desc
limit 20;

-- 6) Trades — Paper Trades panel
select kind, label, symbol, side, qty, price, exit_price,
       entry_at, exit_at, trade_date, pnl, realized_pnl, reason
from model_trade_c
where model_slug = 'qentari_bravo_jse'
order by coalesce(exit_at, trade_date) desc nulls last
limit 20;

-- 7) Push log — Data Sync panel
select created_at, kind, status, rows_pushed, message
from model_run_c
where model_slug = 'qentari_bravo_jse'
order by created_at desc
limit 15;

-- 8) Reproduce the exact BFF select for the benchmark route — should be a real row
--    (the bug is the BFF ALSO selects `benchmark` which doesn't exist)
select slug, currency
from model_registry_c
where slug = 'qentari_bravo_jse';

-- 8b) The benchmark route's `select=slug,currency,benchmark` — `benchmark` column
--     does not exist (see block 0b) so PostgREST errors. `maybeSingle()` in the BFF
--     swallows the error into 404 'model not found'. Skip running this block —
--     it raises the same 42703 you just saw.

-- 9) RLS sanity — service-role is the only role that should touch these tables.
--    If the page is using anon/authenticated, expect 0 rows.
select c.relname as table_name, c.relrowsecurity as rls_on, c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'model_registry_c','model_metric_c','model_equity_point_c',
    'model_prediction_c','model_position_c','model_trade_c','model_run_c'
  )
order by c.relname;

-- 10) Policies on those tables
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename like 'model_%_c'
order by tablename, policyname;