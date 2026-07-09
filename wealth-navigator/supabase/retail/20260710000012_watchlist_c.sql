-- 20260710000012_watchlist_c.sql
-- Mint Phase C5 — promote the per-user watchlist from localStorage to a
-- RETAIL DB table so it follows the analyst across devices.
--
-- The BFF route `/api/admin/watchlist` already targets this table
-- (`user_email`/`symbol`/`note`/`added_at`/`created_at`) — it gracefully
-- degrades to localStorage when the table hasn't been migrated yet, so this
-- DDL is strictly additive: pasting it on top of an existing environment
-- upgrades the watchlist to persistent storage with no client-side change.
--
-- `user_email` (not `user_id`) mirrors the existing RETAIL auth model
-- (`admin_team.email`) so the GET/POST/DELETE in
-- `/api/admin/watchlist/route.ts` can keep its `ilike('user_email', ctx.email)`
-- lookup without a FK.
--
-- All writes are user-pasted in the Supabase SQL editor (no auto-DDL on LIVE
-- per AGENTS.md).

CREATE TABLE IF NOT EXISTS watchlist_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  symbol TEXT NOT NULL,
  note TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_email, symbol)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist_c(user_email);
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist_c(symbol);

ALTER TABLE watchlist_c ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS watchlist_service_role ON watchlist_c
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);