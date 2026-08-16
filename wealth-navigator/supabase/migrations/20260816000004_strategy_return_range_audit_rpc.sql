-- Read-only, strategy-scoped range audit used by operations to compare the
-- guarded publication chain with the certified Excel-style ledger.
begin;

create or replace function public.get_strategy_return_range_audit_c(
  p_strategy_id uuid,
  p_as_of_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with scoped_ledger as materialized (
  select * from public.strategy_daily_ledger_c
  where strategy_id = p_strategy_id and as_of_date <= p_as_of_date
), current_row as (
  select * from scoped_ledger where as_of_date = p_as_of_date
), strategy as (
  select created_at::date created_date from public.strategies_c where id = p_strategy_id
), effective_current as (
  select all_pct from public.strategy_returns_effective_c
  where strategy_id = p_strategy_id and as_of_date = p_as_of_date
), endpoints as (
  select current_row.*, effective_current.all_pct,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date < current_row.as_of_date order by prior.as_of_date desc limit 1) one_day_start_date,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date <= (current_row.as_of_date-interval '7 days')::date order by prior.as_of_date desc limit 1) one_week_start_date,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date < date_trunc('week',current_row.as_of_date::timestamp)::date order by prior.as_of_date desc limit 1) wtd_start_date,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date <= (current_row.as_of_date-interval '1 month')::date order by prior.as_of_date desc limit 1) one_month_start_date,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date <= (current_row.as_of_date-interval '3 months')::date order by prior.as_of_date desc limit 1) three_month_start_date,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date <= make_date(extract(year from current_row.as_of_date)::integer-1,12,31) order by prior.as_of_date desc limit 1) ytd_start_date,
    (select prior.as_of_date from scoped_ledger prior join public.jse_trading_calendar cal on cal.market='JSE_EQUITIES' and cal.trading_date=prior.as_of_date and cal.is_trading_day where prior.as_of_date >= strategy.created_date order by prior.as_of_date asc limit 1) since_inception_start_date
  from current_row cross join strategy left join effective_current on true
), periods as (
  select '1D'::text period_code, one_day_start_date start_date from endpoints
  union all select '1W',one_week_start_date from endpoints
  union all select 'WTD',wtd_start_date from endpoints
  union all select '1M',one_month_start_date from endpoints
  union all select '3M',three_month_start_date from endpoints
  union all select 'YTD',ytd_start_date from endpoints
  union all select 'SI',since_inception_start_date from endpoints
), resolved as (
  select periods.period_code,periods.start_date,start_row.complete_value_cents start_value_cents,
    exists(select 1 from scoped_ledger boundary_row where periods.start_date is not null and boundary_row.as_of_date>periods.start_date and boundary_row.as_of_date<=p_as_of_date and boundary_row.boundary_batch_id is not null) crosses_rebalance_boundary,
    coalesce(start_row.chain_factor,1+(start_row.ytd_pct/100.0)) start_chain_factor,
    coalesce(endpoints.chain_factor,1+(endpoints.ytd_pct/100.0)) end_chain_factor,
    endpoints.complete_value_cents,endpoints.market_status,endpoints.ytd_pct published_ytd_pct,endpoints.all_pct published_all_pct
  from periods cross join endpoints left join scoped_ledger start_row on start_row.as_of_date=periods.start_date
), period_json as (
  select period_code,jsonb_build_object(
    'start_date',start_date,'start_value_cents',start_value_cents,'crosses_rebalance_boundary',crosses_rebalance_boundary,
    'return_method',case when period_code='YTD' and published_ytd_pct is not null then 'PUBLISHED_YTD_CHAIN' when period_code='SI' and published_all_pct is not null then 'PUBLISHED_INCEPTION_CHAIN' when crosses_rebalance_boundary and start_chain_factor>0 and end_chain_factor>0 then 'CHAIN_ACROSS_REBALANCE' when crosses_rebalance_boundary then 'CHAIN_UNAVAILABLE' else 'DIRECT_MODEL_NAV' end,
    'return_pct_candidate',case when period_code='YTD' and published_ytd_pct is not null then published_ytd_pct when period_code='SI' and published_all_pct is not null then published_all_pct when start_date is null or start_value_cents<=0 then null when crosses_rebalance_boundary and start_chain_factor>0 and end_chain_factor>0 then round(((end_chain_factor/start_chain_factor)-1)*100,6) when crosses_rebalance_boundary then null else round(((complete_value_cents::numeric/start_value_cents)-1)*100,6) end,
    'audit_status',case when period_code='YTD' and published_ytd_pct is not null and market_status='TRADING_DAY' then 'READY_FOR_AUDIT' when period_code='SI' and published_all_pct is not null and market_status='TRADING_DAY' then 'READY_FOR_AUDIT' when start_date is null then 'MISSING_START_VALUE' when crosses_rebalance_boundary and (start_chain_factor is null or start_chain_factor<=0 or end_chain_factor is null or end_chain_factor<=0) then 'BOUNDARY_CHAIN_UNAVAILABLE' when market_status<>'TRADING_DAY' then 'NON_TRADING_DAY_DISPLAY_ONLY' else 'READY_FOR_AUDIT' end
  ) value from resolved
)
select jsonb_build_object(
  'strategy_id',p_strategy_id,'as_of_date',p_as_of_date,
  'complete_value_cents',(select complete_value_cents from current_row),
  'securities_value_cents',(select securities_value_cents from current_row),
  'continuity_cash_cents',(select continuity_cash_cents from current_row),
  'market_status',(select market_status from current_row),
  'periods',coalesce((select jsonb_object_agg(period_code,value) from period_json),'{}'::jsonb)
);
$$;

revoke all on function public.get_strategy_return_range_audit_c(uuid,date) from public,anon,authenticated;
grant execute on function public.get_strategy_return_range_audit_c(uuid,date) to service_role;
comment on function public.get_strategy_return_range_audit_c(uuid,date) is
  'Read-only scoped audit for daily, weekly, monthly, YTD and since-inception strategy return candidates.';
notify pgrst,'reload schema';
commit;
