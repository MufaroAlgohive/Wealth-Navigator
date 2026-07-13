-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (INSTITUTIONAL)
-- Expand oems_order_audit.status to the full 8-state IRESS Hermes lifecycle
-- (pending_ack, acknowledged, expired) so the worker mapper can stamp the
-- exact state without losing information on downmap.
--
-- Idempotent: safe to re-run. Drops the original CHECK constraint, adds the
-- extended one, then refreshes the table comment.

ALTER TABLE public.oems_order_audit DROP CONSTRAINT IF EXISTS oems_order_audit_status_check;

ALTER TABLE public.oems_order_audit
  ADD CONSTRAINT oems_order_audit_status_check
  CHECK (status IN (
    'created',
    'pending_ack',
    'acknowledged',
    'working',
    'partial',
    'filled',
    'cancelled',
    'expired',
    'rejected',
    'amended'
  ));

COMMENT ON CONSTRAINT oems_order_audit_status_check ON public.oems_order_audit IS
  'OEMS 8-state lifecycle: pending_ack / acknowledged come from Hermes ActionStatus; expired from a Day TIF rollover; the rest are the IRESS OrderState downmap. See src/types/iress.ts::OrderState.';
