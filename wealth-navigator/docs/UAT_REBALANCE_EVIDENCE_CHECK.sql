-- UAT rebalance evidence check (READ ONLY)
--
-- Run this after a manual UAT rebalance has completely filled. Replace the
-- strategy name and dates below. This script never inserts, updates or deletes.
--
-- Expected result: one SETTLED/COMPLETE batch, BUY and/or SELL event rows with
-- a positive avg_fill and fill_date, cash/reserve rows where applicable, and a
-- return-publication boundary carrying that batch id.

with target as (
  select id, name
  from public.strategies_c
  where name = 'Test Strategy' -- replace with the UAT strategy name
), batches as (
  select b.*
  from public.rebalance_batch b
  join target t on t.id = b.strategy_id
  where b.effective_date >= current_date - 7
  order by b.created_at desc
)
select
  b.id as batch_id,
  b.status,
  b.settlement_state,
  b.effective_date,
  b.settled_at,
  b.strategy_name_snapshot,
  count(e.id) as execution_event_count,
  count(e.id) filter (where e.trade_side = 'BUY') as buy_event_count,
  count(e.id) filter (where e.trade_side = 'SELL') as sell_event_count,
  count(e.id) filter (where e.avg_fill > 0 and e.fill_date is not null) as filled_event_count,
  count(c.id) as cash_event_count,
  count(r.id) as reserve_event_count,
  count(p.id) as sealed_return_boundary_count
from batches b
left join public.rebalance_event e on e.batch_id = b.id
left join public.strategy_rebalance_cash_events_c c on c.batch_id = b.id
left join public.strategy_rebalance_reserve_events_c r on r.batch_id = b.id
left join public.strategy_return_publication_audit_c p on p.boundary_batch_id = b.id
group by b.id, b.status, b.settlement_state, b.effective_date, b.settled_at, b.strategy_name_snapshot
order by b.settled_at desc nulls last, b.created_at desc;

-- Inspect the actual immutable trade evidence for a selected batch id.
-- Replace <batch-uuid>.
select
  e.trade_side,
  s.symbol,
  e.quantity,
  e.price_at_commit,
  e.avg_fill,
  e.fill_date,
  e.closed_reason,
  e.user_id,
  e.family_member_id
from public.rebalance_event e
join public.securities_c s on s.id = e.security_id
where e.batch_id = '<batch-uuid>'::uuid
order by e.trade_side, s.symbol, e.user_id;

-- A UAT rebalance is ready for canonical-ledger review only when the first
-- query shows: status=SETTLED, settlement_state=COMPLETE, filled_event_count
-- equals execution_event_count, and sealed_return_boundary_count is at least 1.
