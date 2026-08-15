begin;

-- A strategy purchase already records its execution reserve on transactions.
-- Keep the model's cash asset on the same transaction as separate evidence:
--
--   base_amount = securities budget + model cash asset
--   buffer       = the owner's 8% execution reserve
--
-- The two balances have different purposes and must never be merged.
alter table public.transactions
  add column if not exists strategy_id uuid null references public.strategies_c(id) on delete restrict,
  add column if not exists strategy_model_lots integer null,
  add column if not exists strategy_model_cash_cents bigint null,
  add column if not exists model_cash_allocated_at timestamptz null;

alter table public.transactions
  drop constraint if exists transactions_strategy_model_lots_check,
  add constraint transactions_strategy_model_lots_check
    check (strategy_model_lots is null or strategy_model_lots > 0),
  drop constraint if exists transactions_strategy_model_cash_cents_check,
  add constraint transactions_strategy_model_cash_cents_check
    check (strategy_model_cash_cents is null or strategy_model_cash_cents >= 0),
  drop constraint if exists transactions_model_cash_allocation_shape_check,
  add constraint transactions_model_cash_allocation_shape_check check (
    (model_cash_allocated_at is null
      and strategy_model_lots is null
      and strategy_model_cash_cents is null)
    or
    (model_cash_allocated_at is not null
      and strategy_id is not null
      and strategy_model_lots is not null
      and strategy_model_cash_cents is not null)
  );

create index if not exists transactions_strategy_model_cash_idx
  on public.transactions(strategy_id, model_cash_allocated_at)
  where strategy_id is not null;

comment on column public.transactions.strategy_model_cash_cents is
  'Model CA allocated to this owner at purchase. Excludes the 8% execution reserve in buffer_cents.';

-- Insert every constituent and allocate the strategy cash sleeve in one
-- database transaction. The function is idempotent by transaction id, locks
-- the owner/strategy cash balance, and reads CA only from the effective ACTIVE
-- valuation rule. No client-supplied cash number is accepted.
create or replace function public.record_strategy_purchase_with_model_cash(
  p_transaction_id uuid,
  p_strategy_id uuid,
  p_strategy_name text,
  p_model_lots integer,
  p_holdings jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx public.transactions%rowtype;
  v_cash_per_lot bigint;
  v_total_cash bigint;
  v_existing_balance bigint;
  v_holding jsonb;
  v_holding_id uuid;
  v_holding_ids jsonb := '[]'::jsonb;
  v_inserted integer := 0;
begin
  if p_transaction_id is null or p_strategy_id is null
     or p_model_lots is null or p_model_lots <= 0
     or jsonb_typeof(p_holdings) <> 'array'
     or jsonb_array_length(p_holdings) = 0 then
    raise exception 'Transaction, strategy, positive model lots and holdings are required';
  end if;

  select * into v_tx
    from public.transactions
   where id = p_transaction_id
   for update;
  if not found then raise exception 'Unknown purchase transaction %', p_transaction_id; end if;
  if v_tx.direction <> 'debit' or v_tx.status <> 'posted' or coalesce(v_tx.reversed, false) then
    raise exception 'Model cash requires an active posted debit transaction';
  end if;

  if v_tx.model_cash_allocated_at is not null then
    if v_tx.strategy_id is distinct from p_strategy_id
       or v_tx.strategy_model_lots is distinct from p_model_lots then
      raise exception 'Transaction was already allocated to a different strategy purchase';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'holding_id', h.id,
      'security_id', h.security_id,
      'quantity', h.quantity
    ) order by h.created_at, h.id), '[]'::jsonb)
      into v_holding_ids
      from public.stock_holdings_c h
     where h.transaction_id = p_transaction_id
       and h.strategy_id = p_strategy_id;
    return jsonb_build_object(
      'idempotent', true,
      'model_lots', v_tx.strategy_model_lots,
      'model_cash_cents', v_tx.strategy_model_cash_cents,
      'holdings', v_holding_ids
    );
  end if;

  if exists (
    select 1 from public.stock_holdings_c h
     where h.transaction_id = p_transaction_id
       and h.strategy_id = p_strategy_id
  ) then
    raise exception 'Unallocated transaction already has partial strategy holdings';
  end if;

  select r.continuity_cash_per_lot_cents
    into v_cash_per_lot
    from public.strategy_valuation_rules_c r
   where r.strategy_id = p_strategy_id
     and r.status = 'ACTIVE'
     and r.effective_from <= coalesce(v_tx.transaction_date::date, v_tx.created_at::date, current_date)
   order by r.effective_from desc, r.created_at desc
   limit 1;
  if not found or v_cash_per_lot is null or v_cash_per_lot < 0 then
    raise exception 'Strategy has no effective ACTIVE model cash rule';
  end if;

  v_total_cash := v_cash_per_lot * p_model_lots;
  if coalesce(v_tx.base_amount_cents, 0) < v_total_cash then
    raise exception 'Purchase base amount cannot fund the model cash allocation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_tx.user_id::text || ':' || p_strategy_id::text || ':' || coalesce(v_tx.family_member_id::text, 'self'),
    0
  ));

  for v_holding in select value from jsonb_array_elements(p_holdings) loop
    if nullif(v_holding->>'security_id', '') is null
       or coalesce((v_holding->>'quantity')::numeric, 0) <= 0 then
      raise exception 'Every strategy holding requires a security and positive quantity';
    end if;
    insert into public.stock_holdings_c(
      user_id, family_member_id, security_id, strategy_id, quantity,
      avg_fill, market_value, unrealized_pnl, as_of_date, "Status",
      transaction_id, "Expected_fill", strategy_name_snapshot,
      trade_side, is_active
    ) values (
      v_tx.user_id,
      v_tx.family_member_id,
      (v_holding->>'security_id')::uuid,
      p_strategy_id,
      (v_holding->>'quantity')::numeric,
      null,
      0,
      0,
      null,
      'active',
      p_transaction_id,
      nullif(v_holding->>'expected_fill', '')::numeric,
      nullif(trim(p_strategy_name), ''),
      'BUY',
      true
    ) returning id into v_holding_id;
    v_holding_ids := v_holding_ids || jsonb_build_array(jsonb_build_object(
      'holding_id', v_holding_id,
      'security_id', (v_holding->>'security_id')::uuid,
      'quantity', (v_holding->>'quantity')::numeric,
      'symbol', v_holding->>'symbol',
      'price_cents', nullif(v_holding->>'price_cents', '')::bigint
    ));
    v_inserted := v_inserted + 1;
  end loop;

  select balance_cents into v_existing_balance
    from public.strategy_rebalance_residuals
   where user_id = v_tx.user_id
     and strategy_id = p_strategy_id
     and family_member_id is not distinct from v_tx.family_member_id
   for update;
  if found then
    update public.strategy_rebalance_residuals
       set balance_cents = v_existing_balance + v_total_cash,
           updated_at = now()
     where user_id = v_tx.user_id
       and strategy_id = p_strategy_id
       and family_member_id is not distinct from v_tx.family_member_id;
  else
    insert into public.strategy_rebalance_residuals(
      user_id, family_member_id, strategy_id, balance_cents, updated_at
    ) values (
      v_tx.user_id, v_tx.family_member_id, p_strategy_id, v_total_cash, now()
    );
  end if;

  update public.transactions
     set strategy_id = p_strategy_id,
         strategy_model_lots = p_model_lots,
         strategy_model_cash_cents = v_total_cash,
         model_cash_allocated_at = now()
   where id = p_transaction_id;

  return jsonb_build_object(
    'idempotent', false,
    'model_lots', p_model_lots,
    'cash_per_lot_cents', v_cash_per_lot,
    'model_cash_cents', v_total_cash,
    'reserve_cents', coalesce(v_tx.buffer_cents, 0),
    'holdings_inserted', v_inserted,
    'holdings', v_holding_ids
  );
end;
$$;

revoke all on function public.record_strategy_purchase_with_model_cash(uuid, uuid, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_strategy_purchase_with_model_cash(uuid, uuid, text, integer, jsonb)
  to service_role;

commit;
