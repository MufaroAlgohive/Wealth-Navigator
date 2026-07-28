-- REVIEW BEFORE APPLY -- LIVE PROJECT nnwzhxfjpjbzujevwzlh (INSTITUTIONAL)
-- Closed Books for the OEM order-book archive — mirrors MyMintAdmin's
-- orderbook_email_runs.closed_at (public/orderbook.html): an admin moves a
-- fully-filled order book to "Closed Books" once its confirmation email has
-- gone out. Shared across every admin (not per-browser localStorage).
--
-- email_status/email_error/email_sent_at track the desk CSV confirmation
-- email (see /api/admin/orderbook/close-book) so the archive can render an
-- "Email Sent" / "Email Failed" (retryable) chip per book, same as the CRM.
--
-- Idempotent: safe to re-run.

alter table public.oems_order_book
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by text,
  add column if not exists email_status text check (email_status in ('sent', 'failed')),
  add column if not exists email_error text,
  add column if not exists email_sent_at timestamptz;

comment on column public.oems_order_book.closed_at is
  'Set when an admin clicks "Move to Closed Book" on a fully-filled book. Shared across admins. Cleared (set null) to reopen.';
comment on column public.oems_order_book.email_status is
  'Desk confirmation-email outcome for this book: sent | failed. Failed is retryable from the Closed Books view.';
