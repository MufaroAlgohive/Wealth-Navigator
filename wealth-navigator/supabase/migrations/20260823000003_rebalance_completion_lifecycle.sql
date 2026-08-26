-- REVIEW/APPLY TO INSTITUTIONAL project nnwzhxfjpjbzujevwzlh.
-- Separates order booking (`executed`) from genuinely finished settlement
-- (`completed`) and stores the deterministic RETAIL rebalance_batch id used
-- to resume a completion safely after a transient failure.

ALTER TABLE public.rebalance_request_c
  ADD COLUMN IF NOT EXISTS completion_batch_id uuid,
  ADD COLUMN IF NOT EXISTS completion_error text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.rebalance_request_c
  DROP CONSTRAINT IF EXISTS rebalance_request_c_status_check;

ALTER TABLE public.rebalance_request_c
  ADD CONSTRAINT rebalance_request_c_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'ic_approved'::text,
    'executed'::text,
    'completing'::text,
    'completed'::text,
    'rejected'::text,
    'cancelled'::text
  ]));

CREATE INDEX IF NOT EXISTS rebalance_request_c_completion_idx
  ON public.rebalance_request_c (status, completion_batch_id)
  WHERE status IN ('executed', 'completing');
