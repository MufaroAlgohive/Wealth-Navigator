-- REVIEW BEFORE APPLY — INSTITUTIONAL project nnwzhxfjpjbzujevwzlh
--
-- Reserved audit table for individual rebalance orders requiring manual
-- intervention. The completion gate does not use this table and does not
-- allow partial success: strategies_c.holdings remains unchanged unless
-- every required order is fully filled. This migration remains tracked
-- because the table has already been applied to INSTITUTIONAL.
--
-- Each row is resolved by running a corrective single-client rebalance for
-- that client (the existing, already-correct `single_user` scope path in
-- complete-rebalance.ts) and marking resolved_at/resolved_by.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.rebalance_intervention_c (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rebalance_request_id uuid NOT NULL REFERENCES public.rebalance_request_c(id),
  strategy_id text NOT NULL,
  strategy_name text,
  user_id uuid NOT NULL,
  family_member_id uuid,
  security_id uuid,
  side text,                                -- 'buy' | 'sell', from the order's side
  order_status text NOT NULL,               -- 'cancelled' | 'rejected' | 'expired' | 'failed'
  order_id text,                            -- oems_order_audit.order_id, for cross-reference
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_at timestamptz,
  resolved_by text,                         -- admin email who ran the corrective rebalance
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rebalance_intervention_c IS
  'Clients omitted from a rebalance group''s achieved composition because their order did not fill. Queryable record so a straggler is never silently lost — resolved via a single-client corrective rebalance.';

CREATE INDEX IF NOT EXISTS rebalance_intervention_c_open_idx
  ON public.rebalance_intervention_c (status, created_at)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS rebalance_intervention_c_request_idx
  ON public.rebalance_intervention_c (rebalance_request_id);

-- Service role bypasses RLS; anon/authenticated should not read/write this
-- directly — the admin API reads it via the INSTITUTIONAL service-role
-- client, same as rebalance_request_c itself.
ALTER TABLE public.rebalance_intervention_c ENABLE ROW LEVEL SECURITY;

-- No policies = deny for anon/authenticated; service_role still has full access.
