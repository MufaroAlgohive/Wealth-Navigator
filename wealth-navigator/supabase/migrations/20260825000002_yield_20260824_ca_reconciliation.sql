begin;

-- REVIEW BEFORE APPLY — RETAIL project mfxnghmuccevsxwcetej
--
-- Missing public-model CA reconciliation for the Yield Basket BVT rebalance
-- that settled 2026-08-24. Unlike the MyGrowth 2026-07-23 precedent (a
-- sell-then-buy swap), this batch is a pure buy: two clients each bought 1
-- BVT funded entirely from their OWN residual cash, no security was sold, so
-- there is no swap surplus to distribute. The model itself carries no cash
-- leg (strategies_c.holdings has no CASH entry), so its own CA stays zero,
-- same identity as the precedent:
--
--   model capital = securities value + model CA
--       R2,034.03 = R2,034.03        + R0.00
--
-- Owner residual/reserve are NOT model CA (same rule as the precedent) —
-- each owner's residual absorbed their own R238.84 purchase cost and each
-- owner's execution reserve absorbed R25.60 in fees, independently verified
-- against strategy_rebalance_cash_events_c / strategy_rebalance_reserve_events_c
-- below. This does not move client money, alter holdings, change a return
-- row, or touch the 8% execution reserve — it only records the missing
-- public-model identity after rechecking the immutable evidence.
do $$
declare
  v_batch_id constant uuid := '77d9b571-9d03-4896-be83-636367019dea';
  v_strategy_id constant uuid := '640dcffb-dc23-4099-9772-0f72ed9688de';
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
     and effective_date = date '2026-08-24';
  if not found or v_actor is null then
    raise exception 'Yield Basket 2026-08-24 boundary or authoritative actor is missing';
  end if;

  -- Fill evidence: exactly 2 BUY events (no sells), 2 distinct owners,
  -- R238.84 each -> R477.68 total buy cost, zero sell proceeds.
  select
    count(*)::integer,
    count(distinct (user_id, coalesce(family_member_id, '00000000-0000-0000-0000-000000000000'::uuid)))::integer,
    coalesce(sum((quantity * avg_fill)::bigint) filter (where trade_side = 'SELL'), 0),
    coalesce(sum((quantity * avg_fill)::bigint) filter (where trade_side = 'BUY'), 0)
    into v_event_count, v_event_owner_count, v_sell_cents, v_buy_cents
    from public.rebalance_event
   where batch_id = v_batch_id
     and fill_date = date '2026-08-24'
     and quantity > 0
     and avg_fill > 0;
  if v_event_count <> 2 or v_event_owner_count <> 2
     or v_sell_cents <> 0 or v_buy_cents <> 47768 then
    raise exception 'Yield Basket fill evidence changed: events %, owners %, sell %, buy %',
      v_event_count, v_event_owner_count, v_sell_cents, v_buy_cents;
  end if;

  if exists (
    select 1
      from public.rebalance_event e
     where e.batch_id = v_batch_id
     group by e.user_id, e.family_member_id
    having coalesce(sum(case when e.trade_side = 'SELL' then -e.quantity else e.quantity end)
             filter (where e.security_id = 'a2356cce-7953-4c85-8771-38f60eafaaa8'::uuid), 0) <> 1
  ) then
    raise exception 'Yield Basket owner fill deltas no longer match BVT +1 per owner';
  end if;

  -- Each owner's residual absorbed exactly R238.84 (23884 cents) of purchase
  -- cost, funded from their own pre-existing cash, not a swap surplus.
  select count(*)::integer, coalesce(sum(-amount_cents), 0)
    into v_cash_count, v_cash_cents
    from public.strategy_rebalance_cash_events_c
   where batch_id = v_batch_id
     and strategy_id = v_strategy_id
     and event_type = 'REBALANCE_RESIDUAL'
     and amount_cents = -23884
     and closing_balance_cents = opening_balance_cents + amount_cents;
  if v_cash_count <> 2 or v_cash_cents <> 47768 then
    raise exception 'Yield Basket residual evidence changed: rows %, amount %', v_cash_count, v_cash_cents;
  end if;

  -- Each owner's execution reserve funded R25.60 (2560 cents) of fees, zero
  -- shortfall.
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
  if v_reserve_count <> 2 or v_fee_requested_cents <> 5120
     or v_fee_consumed_cents <> 5120 or v_fee_shortfall_cents <> 0 then
    raise exception 'Yield Basket reserve evidence changed: rows %, requested %, consumed %, shortfall %',
      v_reserve_count, v_fee_requested_cents, v_fee_consumed_cents, v_fee_shortfall_cents;
  end if;

  -- Exact 2026-08-24 stored close evidence backing the model's own
  -- securities value (R2,034.03 across the model's 2 NED / 5 SUI / 20 DIB /
  -- 3 TBS / 1 BVT reference basket).
  if not (
    exists (select 1 from public.stock_returns_c where as_of_date = date '2026-08-24' and symbol in ('NED','NED.JO') and current_price = 29961)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-08-24' and symbol in ('SUI','SUI.JO') and current_price = 4851)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-08-24' and symbol in ('DIB','DIB.JO') and current_price = 690)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-08-24' and symbol in ('TBS','TBS.JO') and current_price = 27200)
    and exists (select 1 from public.stock_returns_c where as_of_date = date '2026-08-24' and symbol in ('BVT','BVT.JO') and current_price = 23826)
  ) then
    raise exception 'Exact 2026-08-24 stored close evidence changed';
  end if;

  select * into v_existing
    from public.strategy_rebalance_ca_reconciliation_c
   where batch_id = v_batch_id;
  if found then
    if v_existing.strategy_id <> v_strategy_id
       or v_existing.model_capital_cents <> 203403
       or v_existing.securities_value_cents <> 203403
       or v_existing.strategy_ca_cents <> 0
       or v_existing.affected_owner_count <> 2
       or v_existing.reconciled_owner_count <> 2 then
      raise exception 'Existing Yield Basket reconciliation conflicts with reviewed evidence';
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
      203403,
      203403,
      0,
      2,
      2,
      'CLIENT_RESIDUAL_FUNDED_BUY+EXACT_STORED_EOD_CLOSE',
      jsonb_build_object(
        'audit_version', 'YIELD_20260824_RECONCILIATION_V1',
        'boundary_date', '2026-08-24',
        'model_delta', jsonb_build_object('BVT', 1),
        'event_owner_count', 2,
        'sell_proceeds_cents', 0,
        'buy_cost_cents', 47768,
        'owner_residual_debit_total_cents', 47768,
        'rebalance_fee_total_cents', 5120,
        'fee_shortfall_cents', 0,
        'funded_by', 'CLIENT_OWN_RESIDUAL_CASH',
        'explicit_model_cash_leg_present', false,
        'exact_close_values_cents', jsonb_build_object(
          'NED', 29961, 'SUI', 4851, 'DIB', 690, 'TBS', 27200, 'BVT', 23826
        ),
        'derivation', 'Pure buy, no sell leg; CA is zero, owner residual/reserve are not public model CA'
      ),
      v_actor,
      now()
    );
  end if;
end;
$$;

commit;
