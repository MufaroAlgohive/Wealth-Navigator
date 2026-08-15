begin;

-- Historical evidence repair for the first MyGrowth model boundary.
--
-- This does not move client money, alter holdings, change a return row, or
-- touch the 8% execution reserve. It records the missing public-model identity
-- only after rechecking the immutable execution/cash/reserve evidence:
--
--   model capital = securities value + model CA
--       R1,278.42 = R1,278.42       + R0.00
--
-- Both affected owners received the complete sell-minus-buy surplus as their
-- owner residual (R148.47 each), while R52.27 of fees each came from their
-- separate execution reserves. Owner residual and reserve are not model CA.
do $$
declare
  v_batch_id constant uuid := '414ccb97-c3b4-4992-b0f2-e7a0515f11ed';
  v_strategy_id constant uuid := 'eb95d956-cfac-4fd4-b74f-294d4a2ec21d';
  v_actor uuid;
  v_existing public.strategy_rebalance_ca_reconciliation_c%rowtype;
  v_event_count integer;
  v_event_owner_count integer;
  v_sell_cents bigint;
  v_buy_cents bigint;
  v_cash_count integer;
  v_cash_cents bigint;
  v_reserve_count integer;
  v_fee_requested_cents bigint;
  v_fee_consumed_cents bigint;
  v_fee_shortfall_cents bigint;
begin
  select coalesce(settled_by, created_by)
    into v_actor
    from public.rebalance_batch
   where id = v_batch_id
     and strategy_id = v_strategy_id
     and status = 'SETTLED'
     and settlement_state = 'COMPLETE'
     and effective_date = date '2026-07-23';
  if not found or v_actor is null then
    raise exception 'MyGrowth 2026-07-23 boundary or authoritative actor is missing';
  end if;

  select
    count(*)::integer,
    count(distinct (user_id, coalesce(family_member_id, '00000000-0000-0000-0000-000000000000'::uuid)))::integer,
    coalesce(sum((quantity * avg_fill)::bigint) filter (where trade_side = 'SELL'), 0),
    coalesce(sum((quantity * avg_fill)::bigint) filter (where trade_side = 'BUY'), 0)
    into v_event_count, v_event_owner_count, v_sell_cents, v_buy_cents
    from public.rebalance_event
   where batch_id = v_batch_id
     and fill_date = date '2026-07-23'
     and quantity > 0
     and avg_fill > 0;
  if v_event_count <> 4 or v_event_owner_count <> 2
     or v_sell_cents <> 60210 or v_buy_cents <> 30516 then
    raise exception 'MyGrowth fill evidence changed: events %, owners %, sell %, buy %',
      v_event_count, v_event_owner_count, v_sell_cents, v_buy_cents;
  end if;

  if exists (
    select 1
      from public.rebalance_event e
     where e.batch_id = v_batch_id
     group by e.user_id, e.family_member_id
    having coalesce(sum(case when e.trade_side = 'SELL' then -e.quantity else e.quantity end)
             filter (where e.security_id = '750eadd9-9f42-4009-b864-69e71be13849'::uuid), 0) <> -3
        or coalesce(sum(case when e.trade_side = 'SELL' then -e.quantity else e.quantity end)
             filter (where e.security_id = '3fd88ab5-e316-4832-a732-e9f128bffab0'::uuid), 0) <> 3
  ) then
    raise exception 'MyGrowth owner fill deltas no longer match STX40 -3 / GLPROP +3';
  end if;

  select count(*)::integer, coalesce(sum(amount_cents), 0)
    into v_cash_count, v_cash_cents
    from public.strategy_rebalance_cash_events_c
   where batch_id = v_batch_id
     and strategy_id = v_strategy_id
     and event_type = 'REBALANCE_RESIDUAL'
     and amount_cents = 14847
     and closing_balance_cents = opening_balance_cents + amount_cents;
  if v_cash_count <> 2 or v_cash_cents <> 29694 then
    raise exception 'MyGrowth residual evidence changed: rows %, amount %', v_cash_count, v_cash_cents;
  end if;

  select
    count(*)::integer,
    coalesce(sum(requested_cents), 0),
    coalesce(sum(consumed_cents), 0),
    coalesce(sum(shortfall_cents), 0)
    into v_reserve_count, v_fee_requested_cents, v_fee_consumed_cents, v_fee_shortfall_cents
    from public.strategy_rebalance_reserve_events_c
   where batch_id = v_batch_id
     and strategy_id = v_strategy_id
     and requested_cents = consumed_cents + shortfall_cents
     and reserve_after_cents = reserve_before_cents - consumed_cents;
  if v_reserve_count <> 2 or v_fee_requested_cents <> 10454
     or v_fee_consumed_cents <> 10454 or v_fee_shortfall_cents <> 0 then
    raise exception 'MyGrowth reserve evidence changed: rows %, requested %, consumed %, shortfall %',
      v_reserve_count, v_fee_requested_cents, v_fee_consumed_cents, v_fee_shortfall_cents;
  end if;

  if not exists (
    select 1
      from public.strategy_rebalance_ca_reconciliation_c
     where strategy_id = v_strategy_id
       and strategy_ca_cents = 0
       and reconciled_at > timestamptz '2026-07-23 23:59:59+00'
  ) then
    raise exception 'Subsequent authoritative zero-CA checkpoint is missing';
  end if;

  if not (
    exists (select 1 from public.stock_returns_c where as_of_date = date '2026-07-23' and symbol in ('STXNDQ','STXNDQ.JO') and current_price = 26920)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-07-23' and symbol in ('SYGEMF','SYGEMF.JO') and current_price = 3108)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-07-23' and symbol in ('SYG500','SYG500.JO') and current_price = 12355)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-07-23' and symbol in ('GLPROP','GLPROP.JO') and current_price = 5086)
  ) then
    raise exception 'Exact 2026-07-23 stored close evidence changed';
  end if;

  select * into v_existing
    from public.strategy_rebalance_ca_reconciliation_c
   where batch_id = v_batch_id;
  if found then
    if v_existing.strategy_id <> v_strategy_id
       or v_existing.model_capital_cents <> 127842
       or v_existing.securities_value_cents <> 127842
       or v_existing.strategy_ca_cents <> 0
       or v_existing.affected_owner_count <> 2
       or v_existing.reconciled_owner_count <> 2 then
      raise exception 'Existing MyGrowth reconciliation conflicts with reviewed evidence';
    end if;
  else
    insert into public.strategy_rebalance_ca_reconciliation_c(
      batch_id,
      strategy_id,
      model_capital_cents,
      securities_value_cents,
      strategy_ca_cents,
      affected_owner_count,
      reconciled_owner_count,
      capital_source,
      checks,
      reconciled_by,
      reconciled_at
    ) values (
      v_batch_id,
      v_strategy_id,
      127842,
      127842,
      0,
      2,
      2,
      'HISTORICAL_FULL_RESIDUAL_DISTRIBUTION+EXACT_STORED_EOD_CLOSE',
      jsonb_build_object(
        'audit_version', 'MYGROWTH_20260723_HISTORICAL_REPAIR_V1',
        'boundary_date', '2026-07-23',
        'model_delta', jsonb_build_object('STX40', -3, 'STXNDQ', 0, 'SYGEMF', 0, 'SYG500', 0, 'GLPROP', 3),
        'event_owner_count', 2,
        'sell_proceeds_cents', 60210,
        'buy_cost_cents', 30516,
        'owner_residual_total_cents', 29694,
        'rebalance_fee_total_cents', 10454,
        'fee_shortfall_cents', 0,
        'all_execution_surplus_credited_to_owner_residual', true,
        'all_rebalance_fees_funded_by_execution_reserve', true,
        'explicit_model_cash_leg_present', false,
        'subsequent_zero_ca_checkpoint', true,
        'exact_close_values_cents', jsonb_build_object(
          'STXNDQ', 26920, 'SYGEMF', 3108, 'SYG500', 12355, 'GLPROP', 5086
        ),
        'audit_output_evidence_sha256', 'd492fe723bb4963f27eac6376e4af86a9d76d760b9dffa94a9186de7ac95e6ae',
        'derivation', 'CA is zero; owner residual and execution reserve are not public model CA'
      ),
      v_actor,
      now()
    );
  end if;
end;
$$;

commit;
