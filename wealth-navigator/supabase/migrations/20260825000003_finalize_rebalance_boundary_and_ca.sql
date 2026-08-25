begin;

-- Wraps the two existing, independently-idempotent RPCs
-- (finalize_rebalance_return_boundary, reconcile_rebalance_ca) in one
-- Postgres transaction so a rebalance's return boundary can never be sealed
-- without its corporate-action reconciliation, or vice versa.
--
-- Both callees already commit real financial state on success
-- (strategy_valuation_rules_c / strategy_return_publication_audit_c for the
-- first, strategy_rebalance_ca_reconciliation_c for the second) and both
-- raise on failure rather than swallowing it. Calling them sequentially from
-- application code, as the boundary-sealing helper originally did, meant a
-- reconciliation failure left the return boundary durably sealed against the
-- target composition while strategies_c.holdings still showed the OLD
-- composition until a later retry -- a real partial-state window, not a
-- hypothetical one, since the two calls were separate network round-trips.
-- A single plpgsql function body is one implicit transaction: an unhandled
-- exception from either callee rolls back everything the function did,
-- including whatever the first callee already wrote, so the two either both
-- commit or neither does.
create or replace function public.finalize_rebalance_boundary_and_ca(
  p_batch_id uuid,
  p_securities_value_cents bigint,
  p_holdings_snapshot jsonb,
  p_effective_at timestamptz,
  p_price_observed_at timestamptz,
  p_actor uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_boundary jsonb;
  v_ca jsonb;
begin
  v_boundary := public.finalize_rebalance_return_boundary(
    p_batch_id,
    p_securities_value_cents,
    p_holdings_snapshot,
    p_effective_at,
    p_price_observed_at,
    p_actor
  );
  v_ca := public.reconcile_rebalance_ca(p_batch_id, p_actor);
  return jsonb_build_object('boundary', v_boundary, 'ca', v_ca);
end;
$$;

revoke all on function public.finalize_rebalance_boundary_and_ca(uuid, bigint, jsonb, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_rebalance_boundary_and_ca(uuid, bigint, jsonb, timestamptz, timestamptz, uuid)
  to service_role;

commit;
