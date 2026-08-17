-- Automatic certification for the single physical strategy ledger.
--
-- A scheduled service may promote only an already-built DRAFT. Promotion is
-- atomic and fail-closed: the row is locked; its evidence hash, prior certified
-- checkpoint, JSE trading date, exact-close coverage, active model composition,
-- active continuity-cash rule and rebalance evidence are rechecked in SQL.

begin;

alter table public.strategy_canonical_daily_ledger_c
  add column if not exists certification_actor text;

-- Replace the original anonymous certifier check without depending on the
-- auto-generated constraint suffix used by a particular Supabase instance.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.strategy_canonical_daily_ledger_c'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%certification_status%'
      and pg_get_constraintdef(oid) ilike '%certified_at%'
      and pg_get_constraintdef(oid) ilike '%certified_by%'
  loop
    execute format(
      'alter table public.strategy_canonical_daily_ledger_c drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.strategy_canonical_daily_ledger_c
  drop constraint if exists strategy_canonical_certifier_identity_check;
alter table public.strategy_canonical_daily_ledger_c
  add constraint strategy_canonical_certifier_identity_check check (
    (
      certification_status = 'CERTIFIED'
      and certified_at is not null
      and ((certified_by is not null)::integer + (nullif(trim(certification_actor), '') is not null)::integer) = 1
    )
    or (
      certification_status <> 'CERTIFIED'
      and certified_at is null
      and certified_by is null
      and certification_actor is null
    )
  );

create or replace function public.certify_strategy_canonical_daily_ledger_c(
  p_strategy_id uuid,
  p_as_of_date date,
  p_certification_actor text,
  p_expected_evidence_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current public.strategy_canonical_daily_ledger_c%rowtype;
  v_previous public.strategy_canonical_daily_ledger_c%rowtype;
  v_composition jsonb;
  v_rule_cash bigint;
  v_expected_holdings integer := 0;
  v_covered_holdings integer := 0;
  v_repriced_securities bigint := 0;
  v_period text;
  v_metric jsonb;
  v_writer text;
  v_holdings_match boolean := false;
  v_boundary jsonb;
  v_boundary_batch_id uuid;
  v_boundary_count integer := 0;
begin
  if p_certification_actor <> 'SYSTEM:WEALTH_NAVIGATOR_DAILY_V1' then
    raise exception 'AUTOMATIC_CERTIFICATION_ACTOR_NOT_ALLOWED';
  end if;
  if nullif(trim(coalesce(p_expected_evidence_sha256, '')), '') is null then
    raise exception 'EXPECTED_EVIDENCE_HASH_REQUIRED';
  end if;

  select * into v_current
  from public.strategy_canonical_daily_ledger_c
  where strategy_id = p_strategy_id and as_of_date = p_as_of_date
  for update;
  if not found then raise exception 'CANONICAL_DRAFT_MISSING'; end if;
  if v_current.certification_status = 'CERTIFIED' then
    if v_current.source_evidence_sha256 <> p_expected_evidence_sha256 then
      raise exception 'CERTIFIED_EVIDENCE_HASH_MISMATCH';
    end if;
    return jsonb_build_object('status', 'ALREADY_CERTIFIED', 'strategy_id', p_strategy_id, 'as_of_date', p_as_of_date);
  end if;
  if v_current.certification_status <> 'DRAFT' then raise exception 'ROW_NOT_DRAFT'; end if;
  if v_current.source_evidence_sha256 <> p_expected_evidence_sha256 then
    raise exception 'DRAFT_CHANGED_DURING_CERTIFICATION';
  end if;
  if v_current.complete_value_cents <= 0
     or v_current.complete_value_cents <> v_current.securities_value_cents + v_current.continuity_cash_cents then
    raise exception 'COMPLETE_VALUE_IDENTITY_FAILED';
  end if;
  if not exists (
    select 1 from public.jse_trading_calendar
    where market = 'JSE_EQUITIES' and trading_date = p_as_of_date and is_trading_day
  ) then raise exception 'JSE_TRADING_CLOSE_NOT_CONFIRMED'; end if;

  select * into v_previous
  from public.strategy_canonical_daily_ledger_c
  where strategy_id = p_strategy_id and as_of_date < p_as_of_date
  order by as_of_date desc
  limit 1;
  if not found then raise exception 'AUTOMATIC_CERTIFICATION_REQUIRES_MANUAL_SEED'; end if;
  if v_previous.certification_status <> 'CERTIFIED' then
    raise exception 'PREVIOUS_CHECKPOINT_NOT_CERTIFIED:%', v_previous.as_of_date;
  end if;

  foreach v_period in array array['1D','1W','WTD','1M','3M','YTD','SI'] loop
    v_metric := v_current.period_metrics -> v_period;
    if v_metric is null or jsonb_typeof(v_metric) <> 'object'
       or jsonb_typeof(v_metric -> 'return_pct') <> 'number'
       or jsonb_typeof(v_metric -> 'denominator_cents') <> 'number'
       or (v_metric ->> 'denominator_cents')::numeric <= 0
       or coalesce(v_metric ->> 'reference_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or (v_metric ->> 'reference_date')::date > p_as_of_date then
      raise exception 'PERIOD_METRIC_INVALID:%', v_period;
    end if;
  end loop;

  if not (v_current.source_evidence ? 'opening_model_snapshot')
     or not (v_current.source_evidence ? 'ordered_settled_batches')
     or not (v_current.source_evidence ? 'price_coverage')
     or not (v_current.source_evidence ? 'reconciliation') then
    raise exception 'REQUIRED_EVIDENCE_MISSING';
  end if;
  if coalesce(v_current.source_evidence #>> '{price_coverage,latest_exact_close,as_of_date}', '') <> p_as_of_date::text
     or coalesce((v_current.source_evidence #>> '{price_coverage,latest_exact_close,exact_close_required}')::boolean, false) is not true
     or coalesce((v_current.source_evidence #>> '{reconciliation,latest_daily_value_identity,equation_passed}')::boolean, false) is not true
     or coalesce((v_current.source_evidence #>> '{reconciliation,latest_daily_value_identity,securities_value_cents}')::bigint, -1) <> v_current.securities_value_cents
     or coalesce((v_current.source_evidence #>> '{reconciliation,latest_daily_value_identity,continuity_cash_cents}')::bigint, -1) <> v_current.continuity_cash_cents
     or coalesce((v_current.source_evidence #>> '{reconciliation,latest_daily_value_identity,complete_value_cents}')::bigint, -1) <> v_current.complete_value_cents then
    raise exception 'CURRENT_CLOSE_EVIDENCE_MISSING_OR_MISMATCHED';
  end if;
  v_writer := coalesce(v_current.calculation_notes ->> 'daily_writer', '');
  if v_writer not in ('canonical-draft-stable-composition-v1', 'canonical-draft-evidence-backed-boundary-v2') then
    raise exception 'AUTOMATIC_SEED_FORBIDDEN:%', v_writer;
  end if;

  select holdings into v_composition
  from public.strategy_composition_log_c
  where strategy_id = p_strategy_id
    and effective_from <= p_as_of_date
    and (effective_to is null or effective_to >= p_as_of_date)
  order by effective_from desc, created_at desc
  limit 1;
  if v_composition is null or jsonb_typeof(v_composition) <> 'array' then
    raise exception 'ACTIVE_COMPOSITION_MISSING';
  end if;

  with raw_holdings as (
    select
      regexp_replace(upper(trim(coalesce(h ->> 'ticker', h ->> 'symbol', ''))), '\.(JO|JSE)$', '', 'i') as ticker,
      case
        when coalesce(h ->> 'units', h ->> 'quantity', h ->> 'shares', '') ~ '^[0-9]+([.][0-9]+)?$'
          then coalesce(h ->> 'units', h ->> 'quantity', h ->> 'shares')::numeric
        else null
      end as units
    from jsonb_array_elements(v_composition) h
  ), holdings as (
    select ticker, sum(units) as units
    from raw_holdings where ticker <> '' and units > 0 group by ticker
  ), exact_prices as (
    select distinct on (regexp_replace(upper(trim(symbol)), '\.(JO|JSE)$', '', 'i'))
      regexp_replace(upper(trim(symbol)), '\.(JO|JSE)$', '', 'i') as ticker,
      current_price::numeric as close_cents
    from public.stock_returns_c
    where as_of_date = p_as_of_date and current_price > 0
    order by regexp_replace(upper(trim(symbol)), '\.(JO|JSE)$', '', 'i'), fetched_at desc nulls last
  )
  select count(*)::integer,
         count(p.ticker)::integer,
         coalesce(round(sum(h.units * p.close_cents)), 0)::bigint
  into v_expected_holdings, v_covered_holdings, v_repriced_securities
  from holdings h left join exact_prices p using (ticker);
  if v_expected_holdings <= 0 then raise exception 'ACTIVE_COMPOSITION_EMPTY'; end if;
  if v_covered_holdings <> v_expected_holdings then
    raise exception 'EXACT_CLOSE_COVERAGE_INCOMPLETE:%/%', v_covered_holdings, v_expected_holdings;
  end if;
  if v_repriced_securities <> v_current.securities_value_cents then
    raise exception 'SECURITIES_REPRICE_MISMATCH:%/%', v_repriced_securities, v_current.securities_value_cents;
  end if;

  select continuity_cash_per_lot_cents::bigint into v_rule_cash
  from public.strategy_valuation_rules_c
  where strategy_id = p_strategy_id and status = 'ACTIVE' and effective_from <= p_as_of_date
  order by effective_from desc, created_at desc
  limit 1;
  if not found then raise exception 'ACTIVE_VALUATION_RULE_MISSING'; end if;
  if v_rule_cash <> v_current.continuity_cash_cents then
    raise exception 'CONTINUITY_CASH_RULE_MISMATCH:%/%', v_rule_cash, v_current.continuity_cash_cents;
  end if;

  with current_h as (
    select regexp_replace(upper(trim(coalesce(h ->> 'ticker', h ->> 'symbol', ''))), '\.(JO|JSE)$', '', 'i') ticker,
           sum(coalesce(h ->> 'units', h ->> 'quantity', h ->> 'shares')::numeric) units
    from jsonb_array_elements(v_composition) h
    where coalesce(h ->> 'units', h ->> 'quantity', h ->> 'shares', '') ~ '^[0-9]+([.][0-9]+)?$'
    group by 1
  ), previous_h as (
    select regexp_replace(upper(trim(coalesce(h ->> 'ticker', h ->> 'symbol', ''))), '\.(JO|JSE)$', '', 'i') ticker,
           sum(coalesce(h ->> 'units', h ->> 'quantity', h ->> 'shares')::numeric) units
    from jsonb_array_elements(v_previous.leg_snapshot) h
    where upper(coalesce(h ->> 'ticker', h ->> 'symbol', '')) not in ('CASH','EXECUTION_COST')
      and coalesce((h ->> 'counts_in_current_strategy')::boolean, true)
      and (nullif(h ->> 'exit_date', '') is null or (h ->> 'exit_date')::date > v_previous.as_of_date)
      and coalesce(h ->> 'units', h ->> 'quantity', h ->> 'shares', '') ~ '^[0-9]+([.][0-9]+)?$'
    group by 1
  ), differences as (
    (select * from current_h except select * from previous_h)
    union all
    (select * from previous_h except select * from current_h)
  )
  select not exists(select 1 from differences) into v_holdings_match;

  if not v_holdings_match or v_current.continuity_cash_cents <> v_previous.continuity_cash_cents then
    if v_writer <> 'canonical-draft-evidence-backed-boundary-v2' then
      raise exception 'COMPOSITION_OR_CASH_CHANGED_WITHOUT_BOUNDARY_WRITER';
    end if;
    if jsonb_typeof(v_current.source_evidence -> 'daily_boundaries') <> 'array'
       or jsonb_array_length(v_current.source_evidence -> 'daily_boundaries') = 0 then
      raise exception 'BOUNDARY_EVIDENCE_MISSING';
    end if;
    v_boundary := (v_current.source_evidence -> 'daily_boundaries') ->
      (jsonb_array_length(v_current.source_evidence -> 'daily_boundaries') - 1);
    begin
      v_boundary_batch_id := (v_boundary ->> 'batch_id')::uuid;
    exception when others then
      raise exception 'BOUNDARY_BATCH_ID_INVALID';
    end;
    select count(*)::integer into v_boundary_count
    from public.rebalance_batch b
    join public.strategy_rebalance_ca_reconciliation_c r on r.batch_id = b.id
    where b.id = v_boundary_batch_id
      and b.strategy_id = p_strategy_id
      and b.status = 'SETTLED'
      and b.settlement_state = 'COMPLETE'
      and not b.is_reversed
      and b.effective_date > v_previous.as_of_date
      and b.effective_date <= p_as_of_date
      and r.model_capital_cents = r.securities_value_cents + r.strategy_ca_cents
      and r.affected_owner_count = r.reconciled_owner_count
      and r.strategy_ca_cents = v_current.continuity_cash_cents;
    if v_boundary_count <> 1 then raise exception 'BOUNDARY_DATABASE_EVIDENCE_INVALID'; end if;
  elsif v_writer <> 'canonical-draft-stable-composition-v1' then
    raise exception 'UNEXPECTED_BOUNDARY_WRITER_WITHOUT_MODEL_CHANGE';
  end if;

  update public.strategy_canonical_daily_ledger_c
  set certification_status = 'CERTIFIED',
      certified_at = now(),
      certified_by = null,
      certification_actor = p_certification_actor,
      calculation_notes = calculation_notes || jsonb_build_object(
        'automatic_certification', jsonb_build_object(
          'actor', p_certification_actor,
          'certified_at', now(),
          'database_repriced_securities_cents', v_repriced_securities,
          'exact_close_coverage', jsonb_build_object('covered', v_covered_holdings, 'expected', v_expected_holdings),
          'prior_certified_close', v_previous.as_of_date
        )
      ),
      updated_at = now()
  where strategy_id = p_strategy_id
    and as_of_date = p_as_of_date
    and certification_status = 'DRAFT'
    and source_evidence_sha256 = p_expected_evidence_sha256;
  if not found then raise exception 'ATOMIC_CERTIFICATION_UPDATE_LOST'; end if;

  return jsonb_build_object(
    'status', 'CERTIFIED', 'strategy_id', p_strategy_id, 'as_of_date', p_as_of_date,
    'complete_value_cents', v_current.complete_value_cents,
    'securities_value_cents', v_current.securities_value_cents,
    'continuity_cash_cents', v_current.continuity_cash_cents,
    'certification_actor', p_certification_actor
  );
end;
$$;

revoke all on function public.certify_strategy_canonical_daily_ledger_c(uuid,date,text,text)
  from public, anon, authenticated;
grant execute on function public.certify_strategy_canonical_daily_ledger_c(uuid,date,text,text)
  to service_role;

comment on function public.certify_strategy_canonical_daily_ledger_c(uuid,date,text,text) is
  'Atomically promotes one exact-close canonical DRAFT after independent model, cash, calendar, checkpoint and rebalance checks.';

notify pgrst, 'reload schema';
commit;
