-- Per-strategy rebalance residual cash bucket.
--
-- The old `wallets.rebalance_residual` column was a single per-USER pool —
-- if a user was in multiple strategies, residual cash from any of them
-- accumulated into the same bucket with no traceability. This table
-- replaces that with a per-(user, strategy) ledger so:
--   * MINT can show each strategy's "cash component" in its portfolio total
--   * Future rebalances of strategy X can use ONLY strategy X's leftover cash
--   * The PnL pass-down (Model 2 no-carryover) stays tracked per strategy
--
-- The existing `wallets.rebalance_residual` column STAYS in place and acts
-- as a "legacy unallocated pool". Existing residual balances aren't
-- migrated automatically because they weren't tagged to a strategy at the
-- time of creation. They remain spendable from the wallet modal.

-- Safe to re-run: idempotent CREATE / ALTER blocks handle both a fresh
-- install and an upgrade from the earlier (user_id, strategy_id)-only shape.

CREATE TABLE IF NOT EXISTS public.strategy_rebalance_residuals (
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id   uuid        NOT NULL REFERENCES public.strategies_c(id) ON DELETE CASCADE,
  balance_cents bigint      NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Add family_member_id (idempotent — no-op if column already there).
ALTER TABLE public.strategy_rebalance_residuals
  ADD COLUMN IF NOT EXISTS family_member_id uuid
  REFERENCES public.family_members(id) ON DELETE CASCADE;

-- Drop the old PK on (user_id, strategy_id) if it exists — we need to
-- include family_member_id in the uniqueness constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategy_rebalance_residuals_pkey'
      AND conrelid = 'public.strategy_rebalance_residuals'::regclass
  ) THEN
    ALTER TABLE public.strategy_rebalance_residuals
      DROP CONSTRAINT strategy_rebalance_residuals_pkey;
  END IF;
END $$;

-- Uniqueness is per (user_id, strategy_id, family_member_id). Postgres treats
-- NULLs as distinct in unique indexes by default; here we want NULL to count
-- as a real value (= the parent's own residual) so we use COALESCE in the
-- index expression to fold NULL into a sentinel UUID.
CREATE UNIQUE INDEX IF NOT EXISTS strategy_rebalance_residuals_uniq
  ON public.strategy_rebalance_residuals (
    user_id,
    strategy_id,
    COALESCE(family_member_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Lookup by strategy for admin views ("show me all clients with residual in
-- Strategy X").
CREATE INDEX IF NOT EXISTS strategy_rebalance_residuals_strategy_idx
  ON public.strategy_rebalance_residuals(strategy_id);

-- Lookup by family member for child-view reads in MINT.
CREATE INDEX IF NOT EXISTS strategy_rebalance_residuals_fm_idx
  ON public.strategy_rebalance_residuals(family_member_id)
  WHERE family_member_id IS NOT NULL;

-- RLS: a user can read only their own residuals (parent rows where
-- family_member_id IS NULL, and child rows where they're the parent_user_id
-- on the family_members row — which is captured by user_id matching auth.uid).
-- Writes happen exclusively from the admin app via the service-role key
-- (bypasses RLS).
ALTER TABLE public.strategy_rebalance_residuals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user reads own residuals"
  ON public.strategy_rebalance_residuals;

CREATE POLICY "user reads own residuals"
  ON public.strategy_rebalance_residuals
  FOR SELECT
  USING (auth.uid() = user_id);

-- Sanity check after creation.
SELECT
  (SELECT COUNT(*) FROM public.strategy_rebalance_residuals) AS row_count,
  (SELECT SUM(balance_cents) / 100.0 FROM public.strategy_rebalance_residuals) AS total_rands;
