-- Rebalancing history on stock_holdings (single-table approach)
-- Purpose:
-- 1) Persist BUY/SELL order events for Order Book
-- 2) Keep active BUY bucket as current holdings state
-- 3) Soft-close replaced rows instead of deleting

begin;

alter table public.stock_holdings
  add column if not exists trade_side text not null default 'BUY'
    check (trade_side in ('BUY', 'SELL')),
  add column if not exists is_active boolean not null default true,
  add column if not exists closed_reason text null,
  add column if not exists closed_at timestamptz null,
  add column if not exists rebalance_batch_id uuid null,
  add column if not exists strategy_name_snapshot text null;

-- Backfill existing rows safely
update public.stock_holdings
set
  trade_side = coalesce(trade_side, 'BUY'),
  is_active = coalesce(is_active, true)
where true;

-- Useful indexes for active holdings and orderbook history queries
create index if not exists idx_stock_holdings_active_bucket
  on public.stock_holdings (strategy_id, is_active, trade_side, updated_at desc);

create index if not exists idx_stock_holdings_side_time
  on public.stock_holdings (trade_side, updated_at desc);

create index if not exists idx_stock_holdings_rebalance_batch
  on public.stock_holdings (rebalance_batch_id);

-- Optional cleanup helper:
-- prevent multiple active BUY rows for same user+strategy+security
-- (Only enable if your current data does not violate this.)
-- create unique index if not exists ux_stock_holdings_active_buy
--   on public.stock_holdings (user_id, strategy_id, security_id)
--   where is_active = true and trade_side = 'BUY';

commit;
