-- =============================================================================
-- oems_fill_settlement_c — the idempotency ledger for pushing IRESS fills into
-- the RETAIL database (wallets.balance + stock_holdings_c).
--
-- DATABASE: INSTITUTIONAL (nnwz...). Lives next to oems_order_audit, NOT next
-- to the money it moves. That is deliberate — see "Why claim-first" below.
--
-- WHY THIS TABLE EXISTS
--
-- Until now a filled IRESS order stamped oems_order_audit and stopped there.
-- The client's wallet was never debited and no holding was ever created, so a
-- real R96,00 fill left a R1 000,00 wallet reading R1 000,00 and the client
-- owning nothing. The settlement worker closes that loop.
--
-- Moving client money from a polling loop is only safe if applying the same
-- fill twice is impossible. The order poller re-reads every order on every
-- cycle (OrderFilter=3 deliberately includes INACTIVE//filled rows so final
-- fills are not missed), so WITHOUT a ledger a filled order would be re-applied
-- every ~30 seconds, draining the wallet to zero and minting a new lot each
-- time. This table is what makes the operation idempotent.
--
-- THE INVARIANT
--
--   settled_qty = the quantity of this order already reflected in RETAIL
--
-- Each cycle the worker computes `delta = observed_filled - settled_qty` and
-- applies ONLY the delta. delta <= 0 is a no-op. A partial fill that later
-- completes settles incrementally and correctly: 40 then 60, never 40 then 100.
--
-- WHY CLAIM-FIRST
--
-- The ledger and the money are in two different Postgres instances, so there is
-- no transaction spanning them. Something has to go first, and the choice is
-- which failure you prefer:
--
--   apply-then-record  → crash in between = the fill is applied AGAIN next
--                        cycle. A client is debited twice. Real, silent loss.
--   record-then-apply  → crash in between = the fill is NEVER applied. The
--                        client's cash is untouched and the discrepancy is
--                        visible in this table (settled_qty advanced, but
--                        last_error / the holdings row tells the truth).
--
-- We take record-then-apply, and roll the claim back when the apply fails.
-- It biases toward under-applying, which is detectable and correctable by hand.
-- Double-debiting a client is neither.
--
-- WHAT THE WORKER WRITES INTO RETAIL
--
--   BUY  → INSERT a new lot into stock_holdings_c, and debit wallets.balance.
--          It never updates an existing lot. stock_holdings_c is a lot ledger
--          (108 active rows over 71 distinct user/security pairs as at
--          2026-07-27, 19 pairs holding more than one lot), and mint_account_pnl
--          already values it lot-by-lot. Appending means no existing row's
--          avg_fill — the client's cost basis — is ever rewritten.
--   SELL → close lots FIFO (is_active=false, avg_exit, Exit_date, closed_at),
--          splitting the last lot when the sell is smaller than it, and credit
--          wallets.balance.
--
-- Amounts: settled_cash_rands is RANDS (wallets.balance is rands).
--          stock_holdings_c.avg_fill / avg_exit are CENTS.
-- =============================================================================

create table if not exists public.oems_fill_settlement_c (
  -- The IRESS OrderNumber (oems_order_audit.order_id). One row per order; the
  -- primary key IS the idempotency key.
  order_id            text primary key,

  -- Who the fill belongs to, in RETAIL terms. Captured at settlement time so
  -- the ledger stays readable even if the audit payload is later rewritten.
  user_id             uuid        not null,
  security_id         uuid,
  symbol              text,
  side                text        not null check (side in ('buy', 'sell')),

  -- THE INVARIANT. Quantity of this order already reflected in RETAIL.
  settled_qty         numeric     not null default 0 check (settled_qty >= 0),
  -- Signed cash actually moved, in RANDS: negative for a buy (debit),
  -- positive for a sell (credit). Sums to a reconcilable cash total.
  settled_cash_rands  numeric     not null default 0,

  -- stock_holdings_c rows this order created or closed, so a settlement can be
  -- traced to the exact lots it touched — and unwound by hand if it must be.
  holding_ids         jsonb       not null default '[]'::jsonb,

  -- Set while a claim is in flight, cleared on success. A row where this stays
  -- non-null is a claim that was made but whose RETAIL write failed: the
  -- under-applied case above. This is the column to alert on.
  last_error          text,

  first_settled_at    timestamptz not null default now(),
  last_settled_at     timestamptz not null default now()
);

comment on table public.oems_fill_settlement_c is
  'Idempotency ledger for applying IRESS fills to the RETAIL wallet/holdings. settled_qty is the quantity already reflected; the worker applies only (observed_filled - settled_qty). Claim-first: a non-null last_error means the claim advanced but the RETAIL write did not land.';

comment on column public.oems_fill_settlement_c.settled_qty is
  'Quantity of this order already applied to RETAIL. The worker applies only the delta above this. Never decrease except to roll back a failed claim.';
comment on column public.oems_fill_settlement_c.settled_cash_rands is
  'Signed cash moved in RANDS: negative = debited from the wallet (buy), positive = credited (sell).';
comment on column public.oems_fill_settlement_c.last_error is
  'Non-null means a claim was recorded but the RETAIL write failed — the fill is UNDER-applied. Alert on this.';

-- "What has this client had settled?" and the stuck-claim sweep.
create index if not exists oems_fill_settlement_c_user_idx
  on public.oems_fill_settlement_c (user_id, last_settled_at desc);
create index if not exists oems_fill_settlement_c_stuck_idx
  on public.oems_fill_settlement_c (last_settled_at desc)
  where last_error is not null;

-- RLS: service_role only. This table is written exclusively by the ingest
-- worker and read by admin BFF routes that already hold the service key. No
-- anon or authenticated role has any business here — it is a money ledger.
alter table public.oems_fill_settlement_c enable row level security;

revoke all on public.oems_fill_settlement_c from public;
revoke all on public.oems_fill_settlement_c from anon;
revoke all on public.oems_fill_settlement_c from authenticated;
grant select, insert, update on public.oems_fill_settlement_c to service_role;
