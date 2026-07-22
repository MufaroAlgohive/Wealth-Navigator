-- REVIEW BEFORE APPLY -- LIVE PROJECT nnwzhxfjpjbzujevwzlh (INSTITUTIONAL)
-- Add "parked" status: a pre-send state for mint-triggered client orders
-- (client-order/route.ts) that have NOT been preflighted or sent to the
-- worker/IRESS yet -- zero broker contact until released via
-- /api/admin/orderbook/release-to-market.
--
-- State machine: (mint arrival) -> parked
--   parked --(release: preflight passes, worker accepts)--> working
--   parked --(release: preflight blocks)--> parked (retried on next release)
--   parked --(release: worker rejects post-insert)--> rejected
--
-- Idempotent: safe to re-run; supersedes 20260714000002.

ALTER TABLE public.oems_order_audit DROP CONSTRAINT IF EXISTS oems_order_audit_status_check;

ALTER TABLE public.oems_order_audit
  ADD CONSTRAINT oems_order_audit_status_check
  CHECK (status IN (
    'created',
    'parked',
    'pending_ack',
    'acknowledged',
    'working',
    'partial',
    'filled',
    'cancelled',
    'cancel_pending',
    'expired',
    'rejected',
    'amended',
    'amend_pending',
    'failed'
  ));

COMMENT ON CONSTRAINT oems_order_audit_status_check ON public.oems_order_audit IS
  'OEMS 12-state lifecycle: parked is a new pre-send state for mint client-order rows (zero broker contact until released via /api/admin/orderbook/release-to-market); pending_ack/acknowledged from Hermes ActionStatus; cancel_pending/amend_pending are intermediate instructions; failed is a terminal transport/venue failure (distinct from rejected, which is pre-routing validation); expired is a Day TIF rollover; the rest are the IRESS OrderState downmap. See src/types/iress.ts::OrderState.';
