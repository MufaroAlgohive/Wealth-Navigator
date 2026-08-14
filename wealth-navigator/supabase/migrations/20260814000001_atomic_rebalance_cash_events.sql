-- Immutable and idempotent owner-level cash and reserve evidence for a
-- settled rebalance. The application supplies its calculated proceeds bridge;
-- this function locks and verifies the opening state before changing it.
create or replace function public.record_rebalance_cash_settlement(
  p_batch_id uuid,
  p_settlements jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.rebalance_batch%rowtype;
  v_item jsonb;
  v_user_id uuid;
  v_family_member_id uuid;
  v_strategy_id uuid;
  v_transaction_id uuid;
  v_opening_residual bigint;
  v_closing_residual bigint;
  v_reserve_before bigint;
  v_reserve_used bigint;
  v_reserve_after bigint;
  v_requested bigint;
  v_shortfall bigint;
  v_expected_consumed bigint;
  v_current_consumed bigint;
  v_existing_cash boolean;
  v_existing_reserve boolean;
  v_count integer := 0;
begin
  if p_batch_id is null or jsonb_typeof(p_settlements) <> 'array' then
    raise exception 'A settlement batch and settlement array are required';
  end if;
  select * into v_batch from public.rebalance_batch where id = p_batch_id for update;
  if not found or v_batch.status <> 'SETTLED' or v_batch.settlement_state <> 'COMPLETE' then
    raise exception 'Cash evidence requires a completed settled rebalance batch';
  end if;

  for v_item in select value from jsonb_array_elements(p_settlements) loop
    v_user_id := (v_item->>'user_id')::uuid;
    v_family_member_id := nullif(v_item->>'family_member_id', '')::uuid;
    v_strategy_id := (v_item->>'strategy_id')::uuid;
    v_transaction_id := nullif(v_item->>'transaction_id', '')::uuid;
    v_opening_residual := coalesce((v_item->>'opening_residual_cents')::bigint, 0);
    v_closing_residual := coalesce((v_item->>'closing_residual_cents')::bigint, 0);
    v_reserve_before := coalesce((v_item->>'reserve_before_cents')::bigint, 0);
    v_reserve_used := coalesce((v_item->>'reserve_used_cents')::bigint, 0);
    v_reserve_after := coalesce((v_item->>'reserve_after_cents')::bigint, 0);
    v_requested := coalesce((v_item->>'requested_fee_cents')::bigint, 0);
    v_shortfall := coalesce((v_item->>'fee_shortfall_cents')::bigint, 0);
    v_expected_consumed := coalesce((v_item->>'expected_buffer_consumed_cents')::bigint, 0);
    if v_user_id is null or v_strategy_id is null or v_strategy_id <> v_batch.strategy_id
       or v_opening_residual < 0 or v_closing_residual < 0
       or v_reserve_before < 0 or v_reserve_used < 0 or v_reserve_after < 0
       or v_requested <> v_reserve_used + v_shortfall
       or v_reserve_after <> v_reserve_before - v_reserve_used then
      raise exception 'Invalid rebalance cash settlement payload';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      v_user_id::text || ':' || v_strategy_id::text || ':' || coalesce(v_family_member_id::text, 'self'), 0));
    select exists(select 1 from public.strategy_rebalance_cash_events_c
      where batch_id = p_batch_id and strategy_id = v_strategy_id and user_id = v_user_id
        and family_member_id is not distinct from v_family_member_id) into v_existing_cash;
    select exists(select 1 from public.strategy_rebalance_reserve_events_c
      where batch_id = p_batch_id and strategy_id = v_strategy_id and user_id = v_user_id
        and family_member_id is not distinct from v_family_member_id) into v_existing_reserve;
    if v_existing_cash or v_existing_reserve then
      if not (v_existing_cash and v_existing_reserve) then
        raise exception 'Partial cash evidence exists for batch %, owner %', p_batch_id, v_user_id;
      end if;
      v_count := v_count + 1;
      continue;
    end if;
    if exists(select 1 from public.strategy_rebalance_residuals
      where user_id = v_user_id and strategy_id = v_strategy_id
        and family_member_id is not distinct from v_family_member_id) then
      if (select balance_cents from public.strategy_rebalance_residuals
        where user_id = v_user_id and strategy_id = v_strategy_id
          and family_member_id is not distinct from v_family_member_id) <> v_opening_residual then
        raise exception 'Residual opening balance changed for owner %', v_user_id;
      end if;
      update public.strategy_rebalance_residuals set balance_cents = v_closing_residual, updated_at = now()
        where user_id = v_user_id and strategy_id = v_strategy_id
          and family_member_id is not distinct from v_family_member_id;
    elsif v_opening_residual <> 0 then
      raise exception 'Residual opening balance is missing for owner %', v_user_id;
    else
      insert into public.strategy_rebalance_residuals(user_id, strategy_id, family_member_id, balance_cents)
      values (v_user_id, v_strategy_id, v_family_member_id, v_closing_residual);
    end if;
    if v_transaction_id is not null then
      select buffer_consumed_cents into v_current_consumed from public.transactions
        where id = v_transaction_id for update;
      if not found or coalesce(v_current_consumed, 0) <> v_expected_consumed then
        raise exception 'Execution reserve opening balance changed for owner %', v_user_id;
      end if;
      update public.transactions set buffer_consumed_cents = coalesce(buffer_consumed_cents, 0) + v_reserve_used
        where id = v_transaction_id;
    elsif v_reserve_before <> 0 or v_reserve_used <> 0 then
      raise exception 'Reserve evidence has no source transaction for owner %', v_user_id;
    end if;
    insert into public.strategy_rebalance_cash_events_c(batch_id, strategy_id, user_id, family_member_id, event_type,
      opening_balance_cents, amount_cents, closing_balance_cents, effective_at, metadata)
    values (p_batch_id, v_strategy_id, v_user_id, v_family_member_id, 'REBALANCE_RESIDUAL',
      v_opening_residual, v_closing_residual - v_opening_residual, v_closing_residual, now(),
      v_item - 'user_id' - 'family_member_id' - 'strategy_id' - 'transaction_id');
    insert into public.strategy_rebalance_reserve_events_c(batch_id, strategy_id, user_id, family_member_id,
      requested_cents, consumed_cents, shortfall_cents, reserve_before_cents, reserve_after_cents, metadata)
    values (p_batch_id, v_strategy_id, v_user_id, v_family_member_id, v_requested, v_reserve_used,
      v_shortfall, v_reserve_before, v_reserve_after,
      jsonb_build_object('transaction_id', v_transaction_id, 'cash_event_type', 'REBALANCE_RESIDUAL'));
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'settled_owner_count', v_count);
end;
$$;

revoke all on function public.record_rebalance_cash_settlement(uuid, jsonb) from public;
grant execute on function public.record_rebalance_cash_settlement(uuid, jsonb) to service_role;
