-- REVIEW BEFORE APPLY -- LIVE PROJECT nnwzhxfjpjbzujevwzlh (INSTITUTIONAL)
-- CRM-style order-book numbering for the OEM UAT panel: one row per
-- "Send to Market" click that released one or more parked orders
-- (see /api/admin/orderbook/release-to-market). `sequence` is the
-- CRM-style order-book number shown in the UI ("Orderbook :NN").
--
-- Membership is NOT a foreign-key/join table by design -- it mirrors the
-- existing payload.book_id / payload.strategy convention already used on
-- oems_order_audit: each released row gets payload.order_book_seq stamped
-- onto it, and membership is found via
--   oems_order_audit.payload->>'order_book_seq' = sequence::text
--
-- Lifecycle (computed at read time in /api/admin/orderbook/order-books,
-- no cron/poller):
--   (release-to-market succeeds, >=1 order released) -> row inserted here
--   -> "in progress" while any member order's status is not yet 'filled'
--   -> "fully filled" once EVERY member's status = 'filled' (a cancelled/
--      rejected/expired/failed member means it never promotes)
--   -> (later phase, not this migration) "Move to Closed Book" archival +
--      STRATE settlement file generation
--
-- Idempotent: safe to re-run.

create table if not exists public.oems_order_book (
  id uuid primary key default gen_random_uuid(),
  sequence integer not null,
  released_by text,
  released_at timestamptz not null default now(),
  member_count integer not null default 0
);

create unique index if not exists oems_order_book_sequence_key on public.oems_order_book (sequence);

comment on table public.oems_order_book is
  'One row per "Send to Market" click that released one or more parked orders. sequence is the CRM-style order-book number shown in the OEM UAT panel. Member rows are found via oems_order_audit.payload->>''order_book_seq'' = sequence::text -- no FK/join table by design, mirrors the existing payload.book_id convention. "Fully filled" (all members status=''filled'') is computed at read time by /api/admin/orderbook/order-books, not stored here.';
