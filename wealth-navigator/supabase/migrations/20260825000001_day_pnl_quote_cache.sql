-- REVIEW BEFORE APPLY — RETAIL project mfxnghmuccevsxwcetej
-- Durable, bounded Yahoo fallback cache for the live Day P&L endpoint.
-- Safe to re-run: table, policy posture, and index creation are idempotent.

create table if not exists public.day_pnl_quote_cache_c (
  symbol text primary key,
  price_cents bigint not null check (price_cents > 0),
  previous_close_cents bigint not null check (previous_close_cents > 0),
  exchange_time timestamptz not null,
  fetched_at timestamptz not null default now()
);

comment on table public.day_pnl_quote_cache_c is
  'Durable Yahoo fallback quotes for gross live Day P&L. Allows bounded refresh rotation to survive Vercel cold starts and concurrent instances.';

alter table public.day_pnl_quote_cache_c enable row level security;

-- No anon/authenticated policies. The server-only RETAIL service role owns
-- reads and writes; browsers never access this cache directly.
create index if not exists day_pnl_quote_cache_c_fetched_at_idx
  on public.day_pnl_quote_cache_c (fetched_at asc);
