-- ============================================================================
-- Enable realtime live-price updates on the CRM (orderbook + investors pages)
-- ============================================================================
-- The CRM now subscribes to Postgres change events on the live-price feed so
-- Live Price / Client PnL / MINT PnL move on their own instead of only on a
-- manual refresh. For those events to fire, the tables must be members of the
-- `supabase_realtime` publication. Run this ONCE in the Supabase SQL editor.
--
-- Safe to re-run: each ALTER errors only if the table is already a member, so
-- run them individually and ignore "table is already member of publication".
-- ----------------------------------------------------------------------------

-- Live intraday market price (drives Live Price + Client PnL). This is the one
-- that makes prices tick in real time.
alter publication supabase_realtime add table public.stock_intraday_c;

-- Holding changes (a fill being stamped, a new buy) so the book reacts to fills.
alter publication supabase_realtime add table public.stock_holdings_c;

-- ----------------------------------------------------------------------------
-- Verify membership:
--   select schemaname, tablename
--   from pg_publication_tables
--   where pubname = 'supabase_realtime'
--   order by tablename;
--
-- NOTE on RLS: Supabase Realtime respects Row Level Security — a subscribed
-- browser only receives change events for rows it is allowed to SELECT. The CRM
-- already reads stock_intraday_c / stock_holdings_c with the signed-in admin
-- session, so an admin-readable SELECT policy (or RLS disabled) is already in
-- place; no extra policy is needed for realtime to deliver these events.
--
-- The MINT PnL "shortfall" (buffer_drawdowns_c) is read server-side with the
-- service-role key via /api/orderbook/send-csv?action=get-buffer-drawdowns, so
-- it does NOT depend on RLS or realtime for the browser.
-- ============================================================================
