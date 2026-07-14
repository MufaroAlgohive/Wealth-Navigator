-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (INSTITUTIONAL)
-- Add intermediate "cancel_pending" and "amend_pending" states so the UI can
-- distinguish a trader's instruction that has not yet been acknowledged by the
-- desk broker from a terminal CANCELLED / AMENDED state.
--
-- State machine (8 → 10):
--   WORKING / PARTIAL --(user OrderDelete)--> CANCEL_PENDING
--   CANCEL_PENDING    --(desk ack)----------> CANCELLED
--   WORKING / PARTIAL --(user OrderAmend)--> AMEND_PENDING
--   AMEND_PENDING     --(desk ack)----------> WORKING / PARTIAL  (preserves fills)
--
-- Idempotent: safe to re-run.

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
    'cancel_pending',
    'expired',
    'rejected',
    'amended',
    'amend_pending'
  ));

COMMENT ON CONSTRAINT oems_order_audit_status_check ON public.oems_order_audit IS
  'OEMS 10-state lifecycle: pending_ack / acknowledged come from Hermes ActionStatus; cancel_pending / amend_pending are intermediate instructions that flip to cancelled / working once the desk acknowledges; expired from a Day TIF rollover; the rest are the IRESS OrderState downmap. See src/types/iress.ts::OrderState.';
