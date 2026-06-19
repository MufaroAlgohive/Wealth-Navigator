-- Strategy-level wallet credits per client for rebalance residual cash.
-- Apply this migration before using wallet-funded rebalancing commits.

begin;

create table if not exists public.strategy_client_wallet_credits (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  balance numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint strategy_client_wallet_credits_balance_non_negative check (balance >= 0),
  constraint strategy_client_wallet_credits_unique unique (strategy_id, user_id)
);

create index if not exists idx_strategy_client_wallet_credits_strategy
  on public.strategy_client_wallet_credits (strategy_id, updated_at desc);

create index if not exists idx_strategy_client_wallet_credits_user
  on public.strategy_client_wallet_credits (user_id, updated_at desc);

commit;
