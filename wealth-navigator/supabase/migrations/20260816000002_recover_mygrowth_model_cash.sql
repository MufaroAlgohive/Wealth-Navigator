begin;

-- MyGrowthFund's 3 August settlement used min_investment_planned=R1,038 as
-- total model capital. That number represented only the replacement basket,
-- so reconcile_rebalance_ca incorrectly reduced the strategy cash sleeve to
-- R0.57. The standard one-lot owner ledger proves that the post-fee cash
-- sleeve is R361.91. Owner residuals are the custody location of that model
-- cash; they are deliberately not debited or duplicated by this correction.
do $$
declare
  v_strategy_id uuid;
  v_rule public.strategy_valuation_rules_c%rowtype;
  v_reconciliation public.strategy_rebalance_ca_reconciliation_c%rowtype;
  v_evidence_owner uuid := 'ddf5a938-7d68-451e-af84-9023d8e9e5af'::uuid;
  v_cash_cents bigint;
  v_event_cash_cents bigint;
  v_corrected_model_cents bigint;
  v_publication_count integer;
begin
  select id into strict v_strategy_id
    from public.strategies_c
   where name = 'MyGrowthFund';

  select * into strict v_rule
    from public.strategy_valuation_rules_c
   where strategy_id = v_strategy_id
     and status = 'ACTIVE'
     and effective_from = date '2026-08-03'
   for update;

  if v_rule.securities_value_per_lot_cents <> 103743
     or v_rule.continuity_cash_per_lot_cents <> 57 then
    raise exception
      'MyGrowth rule drifted; expected securities=103743 and cash=57, got securities=% cash=%',
      v_rule.securities_value_per_lot_cents,
      v_rule.continuity_cash_per_lot_cents;
  end if;

  select balance_cents into strict v_cash_cents
    from public.strategy_rebalance_residuals
   where strategy_id = v_strategy_id
     and user_id = v_evidence_owner
     and family_member_id is null;

  select closing_balance_cents into strict v_event_cash_cents
    from public.strategy_rebalance_cash_events_c
   where strategy_id = v_strategy_id
     and user_id = v_evidence_owner
     and family_member_id is null
   order by effective_at desc, created_at desc, id desc
   limit 1;

  if v_cash_cents <> 36191 or v_event_cash_cents <> v_cash_cents then
    raise exception
      'MyGrowth cash evidence drifted; expected residual/event=36191, got residual=% event=%',
      v_cash_cents,
      v_event_cash_cents;
  end if;

  select * into strict v_reconciliation
    from public.strategy_rebalance_ca_reconciliation_c
   where batch_id = '23db1a43-2ebc-429e-9cd1-a6bbb4869875'::uuid
     and strategy_id = v_strategy_id
   for update;

  if v_reconciliation.securities_value_cents <> 103743
     or v_reconciliation.strategy_ca_cents <> 57
     or v_reconciliation.model_capital_cents <> 103800 then
    raise exception
      'MyGrowth reconciliation drifted; expected 103743+57=103800, got %+%=%',
      v_reconciliation.securities_value_cents,
      v_reconciliation.strategy_ca_cents,
      v_reconciliation.model_capital_cents;
  end if;

  v_corrected_model_cents := v_rule.securities_value_per_lot_cents + v_cash_cents;

  update public.strategy_rebalance_ca_reconciliation_c
     set strategy_ca_cents = v_cash_cents,
         model_capital_cents = v_corrected_model_cents,
         capital_source = 'CORRECTED_STANDARD_LOT_OWNER_CASH_LEDGER',
         checks = coalesce(checks, '{}'::jsonb) || jsonb_build_object(
           'cash_recovery_correction', true,
           'cash_evidence_owner', v_evidence_owner,
           'cash_event_closing_balance_cents', v_event_cash_cents,
           'owner_residuals_unchanged', true,
           'execution_reserve_excluded', true,
           'corrected_at', now()
         )
   where id = v_reconciliation.id;

  update public.strategy_valuation_rules_c
     set continuity_cash_per_lot_cents = v_cash_cents,
         methodology_version = 'SETTLEMENT_CA_OWNER_LEDGER_CORRECTED_V3',
         source_evidence = coalesce(source_evidence, '{}'::jsonb) || jsonb_build_object(
           'cash_recovery_correction', true,
           'corrected_from_cents', 57,
           'corrected_to_cents', v_cash_cents,
           'evidence_batch_id', v_reconciliation.batch_id,
           'evidence_owner', v_evidence_owner,
           'owner_residuals_unchanged', true,
           'reason', 'min_investment_planned omitted retained strategy cash'
         )
   where id = v_rule.id;

  -- Static fallback is the effective-date model value. The app's live card
  -- remains holdings at current prices + the same R361.91 cash sleeve.
  update public.strategies_c
     set min_investment = v_corrected_model_cents::numeric / 100,
         updated_at = now()
   where id = v_strategy_id;

  -- Preserve chain_factor/ytd_pct exactly. Only repair the value identity so
  -- the correction cannot be interpreted as investment performance.
  update public.strategy_return_publication_audit_c
     set continuity_cash_cents = v_cash_cents,
         complete_value_cents = securities_value_cents + v_cash_cents,
         checks = coalesce(checks, '{}'::jsonb) || jsonb_build_object(
           'cash_recovery_correction', true,
           'owner_residuals_unchanged', true,
           'return_chain_unchanged', true,
           'corrected_at', now()
         )
   where strategy_id = v_strategy_id
     and as_of_date >= date '2026-08-03';
  get diagnostics v_publication_count = row_count;

  if v_publication_count = 0 then
    raise exception 'No MyGrowth guarded publication rows were corrected';
  end if;
end $$;

commit;

-- Verification (expected current exact-close value after DRAFT replay):
-- securities R1,046.92 + model cash R361.91 = complete value R1,408.83.
