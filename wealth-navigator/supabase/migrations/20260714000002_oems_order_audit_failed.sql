-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (INSTITUTIONAL)
-- Add terminal "failed" status to the OEMS audit CHECK constraint.
--
-- 2026-07-14 (Andre + Juan, transcript 25:08-27:53): Andre brought his IRESS
-- session down on purpose to test the broker-failure path. The OrderCreate3
-- call hung / 502'd but the oems_order_audit row stayed stuck on the
-- BFF-seeded 'working' status, with no operator-visible error. The new
-- worker /uat/send-to-market catch block now stamps status='failed' AND
-- publishes a FAILED SSE delta on transport-level failure (network down,
-- kicked session, venue unavailable, etc).
--
-- FAILED is distinct from REJECTED:
--   - REJECTED : pre-routing validation rejection (broker said "no" with a
--                20xxx IRESS code on OrderCreate3 itself).
--   - FAILED   : post-routing transport / venue failure (the broker may
--                or may not have the order on its book; the worker can't
--                confirm and stamps failed so the operator can investigate).
--                IRESS ErrorNumber + ErrorDescription (when present) are
--                preserved on the audit row payload.
--
-- State machine (10 → 11):
--   PENDING_ACK / WORKING --(transport error)--> FAILED
--   FAILED                 --(operator action)-> terminal (no auto-recovery)
--
-- Idempotent: safe to re-run; supersedes 20260714000001.

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
    'amend_pending',
    'failed'
  ));

COMMENT ON CONSTRAINT oems_order_audit_status_check ON public.oems_order_audit IS
  'OEMS 11-state lifecycle: pending_ack / acknowledged come from Hermes ActionStatus; cancel_pending / amend_pending are intermediate instructions that flip to cancelled / working once the desk acknowledges; failed is a terminal transport / venue failure (distinct from REJECTED which is pre-routing validation); expired from a Day TIF rollover; the rest are the IRESS OrderState downmap. See src/types/iress.ts::OrderState.';
