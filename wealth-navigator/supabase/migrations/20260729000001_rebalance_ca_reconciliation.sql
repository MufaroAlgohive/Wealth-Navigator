begin;

create table if not exists public.strategy_rebalance_ca_reconciliation_c (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null unique references public.rebalance_batch(id) on delete restrict,
  strategy_id uuid not null,
  model_capital_cents bigint not null check (model_capital_cents >= 0),
  securities_value_cents bigint not null check (securities_value_cents >= 0),
  strategy_ca_cents bigint not null check (strategy_ca_cents >= 0),
  affected_owner_count integer not null check (affected_owner_count >= 0),
  reconciled_owner_count integer not null check (reconciled_owner_count >= 0),
  capital_source text not null,
  checks jsonb not null default '{}'::jsonb,
  reconciled_by uuid not null,
  reconciled_at timestamptz not null default now(),
  check (model_capital_cents = securities_value_cents + strategy_ca_cents),
  check (affected_owner_count = reconciled_owner_count)
);

alter table public.strategy_rebalance_ca_reconciliation_c enable row level security;

create or replace function public.reconcile_rebalance_ca(
  p_batch_id uuid,
  p_actor uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.rebalance_batch%rowtype;
  v_boundary public.strategy_return_publication_audit_c%rowtype;
  v_existing public.strategy_rebalance_ca_reconciliation_c%rowtype;
  v_model_rands numeric;
  v_model_cents bigint;
  v_cash bigint;
  v_capital_source text;
  v_affected integer := 0;
  v_reconciled integer := 0;
begin
  if p_batch_id is null or p_actor is null then
    raise exception 'Batch and actor are required';
  end if;

  select * into v_batch
    from public.rebalance_batch where id = p_batch_id for update;
  if not found then raise exception 'Unknown rebalance batch %', p_batch_id; end if;
  if coalesce(v_batch.is_reversed, false) then
    raise exception 'Reversed batch cannot reconcile CA';
  end if;

  select * into v_existing
    from public.strategy_rebalance_ca_reconciliation_c
   where batch_id = p_batch_id;
  if found then
    return jsonb_build_object(
      'idempotent', true, 'reconciliation_id', v_existing.id,
      'model_capital_cents', v_existing.model_capital_cents,
      'securities_value_cents', v_existing.securities_value_cents,
      'strategy_ca_cents', v_existing.strategy_ca_cents,
      'affected_owner_count', v_existing.affected_owner_count
    );
  end if;

  select * into v_boundary
    from public.strategy_return_publication_audit_c
   where boundary_batch_id = p_batch_id for update;
  if not found then
    raise exception 'Return boundary must exist before CA reconciliation';
  end if;

  select coalesce(v_batch.min_investment_planned, s.min_investment),
         case when v_batch.min_investment_planned is not null
           then 'BATCH_PLANNED_MODEL_CAPITAL'
           else 'STRATEGY_MODEL_CAPITAL' end
    into v_model_rands, v_capital_source
    from public.strategies_c s
   where s.id = v_batch.strategy_id;
  if v_model_rands is null or v_model_rands <= 0 then
    raise exception 'Strategy model capital is missing or invalid';
  end if;

  v_model_cents := round(v_model_rands * 100)::bigint;
  if v_boundary.securities_value_cents > v_model_cents then
    v_model_cents := v_boundary.securities_value_cents;
    v_capital_source := v_capital_source || '+ACTUAL_SECURITIES_FLOOR';
  end if;
  v_cash := v_model_cents - v_boundary.securities_value_cents;

  select count(*) into v_affected from (
    select distinct e.user_id, e.family_member_id
      from public.rebalance_event e where e.batch_id = p_batch_id
  ) owners;

  if exists (
    select 1 from (
      select distinct e.user_id, e.family_member_id
        from public.rebalance_event e where e.batch_id = p_batch_id
    ) owner
    where not exists (
      select 1 from public.strategy_rebalance_cash_events_c cash
       where cash.batch_id = p_batch_id
         and cash.strategy_id = v_batch.strategy_id
         and cash.user_id = owner.user_id
         and cash.family_member_id is not distinct from owner.family_member_id
    )
  ) then
    raise exception 'Every affected owner requires an immutable rebalance cash event';
  end if;

  if exists (
    select 1
      from (
        select distinct on (c.user_id, c.family_member_id)
               c.strategy_id, c.user_id, c.family_member_id,
               c.closing_balance_cents
          from public.strategy_rebalance_cash_events_c c
         where c.batch_id = p_batch_id
           and c.strategy_id = v_batch.strategy_id
         order by c.user_id, c.family_member_id, c.created_at desc, c.id desc
      ) cash
      left join public.strategy_rebalance_residuals residual
        on residual.strategy_id = cash.strategy_id
       and residual.user_id = cash.user_id
       and residual.family_member_id is not distinct from cash.family_member_id
     where (residual.user_id is null
         or residual.balance_cents <> cash.closing_balance_cents)
  ) then
    raise exception 'Client residual does not match the immutable cash-event closing balance';
  end if;

  select count(*) into v_reconciled from (
    select distinct cash.user_id, cash.family_member_id
      from public.strategy_rebalance_cash_events_c cash
     where cash.batch_id = p_batch_id
       and cash.strategy_id = v_batch.strategy_id
  ) owners;
  if v_reconciled <> v_affected then
    raise exception 'CA owner reconciliation count mismatch: affected %, reconciled %',
      v_affected, v_reconciled;
  end if;

  update public.strategy_valuation_rules_c
     set securities_value_per_lot_cents = v_boundary.securities_value_cents,
         continuity_cash_per_lot_cents = v_cash,
         methodology_version = 'SETTLEMENT_CA_RECONCILED_V2',
         source_evidence = coalesce(source_evidence, '{}'::jsonb) ||
           jsonb_build_object(
             'batch_id', p_batch_id, 'capital_source', v_capital_source,
             'affected_owner_count', v_affected, 'reserve_excluded', true
           ),
         approved_by = p_actor, approved_at = now()
   where source_batch_id = p_batch_id;
  if not found then
    update public.strategy_valuation_rules_c
       set securities_value_per_lot_cents = v_boundary.securities_value_cents,
           continuity_cash_per_lot_cents = v_cash,
           methodology_version = 'SETTLEMENT_CA_RECONCILED_V2',
           source_evidence = coalesce(source_evidence, '{}'::jsonb) ||
             jsonb_build_object(
               'batch_id', p_batch_id, 'capital_source', v_capital_source,
               'affected_owner_count', v_affected, 'reserve_excluded', true
             ),
           approved_by = p_actor, approved_at = now(),
           source_batch_id = p_batch_id
     where strategy_id = v_batch.strategy_id
       and effective_from = v_boundary.as_of_date
       and status = 'ACTIVE';
  end if;
  if not found then raise exception 'Batch valuation rule is missing'; end if;

  update public.strategy_return_publication_audit_c
     set continuity_cash_cents = v_cash,
         complete_value_cents = v_model_cents,
         checks = coalesce(checks, '{}'::jsonb) ||
           jsonb_build_object(
             'ca_reconciled', true, 'capital_source', v_capital_source,
             'affected_owner_count', v_affected, 'reserve_excluded', true
           ),
         published_at = now()
   where boundary_batch_id = p_batch_id;

  update public.strategies_c
     set min_investment = v_model_cents::numeric / 100, updated_at = now()
   where id = v_batch.strategy_id;

  insert into public.strategy_rebalance_ca_reconciliation_c(
    batch_id, strategy_id, model_capital_cents, securities_value_cents,
    strategy_ca_cents, affected_owner_count, reconciled_owner_count,
    capital_source, checks, reconciled_by
  ) values (
    p_batch_id, v_batch.strategy_id, v_model_cents,
    v_boundary.securities_value_cents, v_cash, v_affected, v_reconciled,
    v_capital_source,
    jsonb_build_object(
      'model_equals_securities_plus_ca', true,
      'client_residuals_match_cash_events', true,
      'execution_reserve_excluded', true
    ), p_actor
  ) returning id into v_existing.id;

  return jsonb_build_object(
    'idempotent', false, 'reconciliation_id', v_existing.id,
    'model_capital_cents', v_model_cents,
    'securities_value_cents', v_boundary.securities_value_cents,
    'strategy_ca_cents', v_cash,
    'affected_owner_count', v_affected,
    'capital_source', v_capital_source
  );
end;
$$;

revoke all on function public.reconcile_rebalance_ca(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_rebalance_ca(uuid, uuid)
  to service_role;

commit;
