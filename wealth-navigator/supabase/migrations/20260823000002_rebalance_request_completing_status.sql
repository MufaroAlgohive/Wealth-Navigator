-- REVIEW BEFORE APPLY — INSTITUTIONAL project nnwzhxfjpjbzujevwzlh
--
-- Adds 'completing' to rebalance_request_c.status, needed by the new
-- idempotency claim in src/lib/rebalance/complete-rebalance.ts: before
-- running the flip/seal/settle sequence, maybeCompleteRebalance() does a
-- conditional update (status: 'ic_approved' -> 'completing') so a repeated
-- poller invocation for the same resolved group is a genuine no-op instead
-- of re-sealing a boundary or re-settling cash. Reverted back to
-- 'ic_approved' on any failure (so the group stays retryable) or advanced
-- to 'executed' on success — 'completing' should never be a resting state.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE public.rebalance_request_c DROP CONSTRAINT IF EXISTS rebalance_request_c_status_check;

ALTER TABLE public.rebalance_request_c ADD CONSTRAINT rebalance_request_c_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'ic_approved'::text, 'completing'::text, 'rejected'::text, 'executed'::text, 'cancelled'::text]));
