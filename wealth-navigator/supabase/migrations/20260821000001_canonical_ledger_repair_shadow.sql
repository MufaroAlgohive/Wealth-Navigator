-- Phase 2 of the canonical-ledger YTD chain-linking fix (PR #142 fixed the calculation going
-- forward; this repairs the historical rows that were written with the old, buggy leg-sum-
-- denominator logic).
--
-- strategy_canonical_daily_ledger_c already has CERTIFIED rows on it - those are immutable,
-- exactly like the July 2026 repair precedent's "production legacy history was NOT destructively
-- overwritten" (see docs/REBALANCE_AND_RETURNS_HANDOVER_2026-08-14.md and
-- scripts/repair-stock-returns-yahoo.mjs / scripts/restore-stock-returns-backup.mjs for that
-- precedent's backup-before-write + explicit-restore pattern). Because
-- strategy_canonical_daily_ledger_c has a UNIQUE(strategy_id, as_of_date) shape (one row per
-- strategy per day, enforced by the app's `.upsert(..., { onConflict: "strategy_id,as_of_date" })`
-- calls), a corrected value for an already-CERTIFIED historical date cannot be written into that
-- table at all without either overwriting the CERTIFIED row (forbidden) or inventing a second key
-- dimension. Rather than partially reuse the production table, this migration creates a genuinely
-- separate shadow table with the same row shape, so full historical reprocessing (including dates
-- that are already CERTIFIED in production) can be computed and reviewed with zero risk of
-- touching production data.
--
-- NOTE ON COLUMN TYPES: strategy_canonical_daily_ledger_c itself predates the tracked migration
-- history (no CREATE TABLE migration exists in this repo for it), so the column shape below is
-- reconstructed from every column name/type used by the application code that reads and writes it
-- (publish-canonical-ledger-draft.ts, publish-canonical-ledger-certification.ts, the
-- 20260816000003 automatic-certification migration, scripts/stage-*-canonical-ledger.ts). This has
-- NOT been verified against a live `\d strategy_canonical_daily_ledger_c` introspection - MCP
-- database access was unavailable while writing this migration. Reconcile against the live schema
-- before applying to production.

begin;

create table if not exists public.strategy_canonical_daily_ledger_repair_c (
  id uuid primary key default gen_random_uuid(),
  repair_run_id uuid not null,
  strategy_id uuid not null references public.strategies_c(id),
  as_of_date date not null,
  ledger_version text not null,
  certification_status text not null default 'DRAFT' check (certification_status in ('DRAFT')),
  securities_value_cents bigint not null,
  continuity_cash_cents bigint not null,
  complete_value_cents bigint not null,
  leg_snapshot jsonb not null default '[]'::jsonb,
  period_metrics jsonb not null default '{}'::jsonb,
  source_evidence jsonb not null default '{}'::jsonb,
  source_evidence_sha256 text not null,
  calculation_notes jsonb not null default '{}'::jsonb,
  carry_forward_price boolean not null default false,
  -- Review/promotion trail. Promotion is a distinct, explicitly human-invoked step
  -- (promote_canonical_ledger_repair_row_c below) - this table's rows are never auto-promoted.
  reviewed_at timestamptz,
  reviewed_by text,
  review_notes text,
  promoted_at timestamptz,
  promoted_by text,
  created_at timestamptz not null default now(),
  constraint strategy_canonical_ledger_repair_complete_value_identity check (
    complete_value_cents = securities_value_cents + continuity_cash_cents
  ),
  constraint strategy_canonical_ledger_repair_unique_row unique (repair_run_id, strategy_id, as_of_date)
);

create index if not exists strategy_canonical_ledger_repair_c_run_idx
  on public.strategy_canonical_daily_ledger_repair_c (repair_run_id);
create index if not exists strategy_canonical_ledger_repair_c_strategy_date_idx
  on public.strategy_canonical_daily_ledger_repair_c (strategy_id, as_of_date);

alter table public.strategy_canonical_daily_ledger_repair_c enable row level security;

-- Service-role only, matching the production ledger's write path (all writers use
-- createRetailServiceRoleClient(), never an authenticated-user session). No anon/authenticated
-- policy is defined, which under RLS means anon/authenticated get zero rows by default; the admin
-- API route that lists repair runs for human review uses the service-role client itself, gated by
-- getAdminContext()/canManageCommittee() in application code, not by a client-side RLS policy.
drop policy if exists "service role full access" on public.strategy_canonical_daily_ledger_repair_c;
create policy "service role full access" on public.strategy_canonical_daily_ledger_repair_c
  for all
  to service_role
  using (true)
  with check (true);

-- Explicit, human-invoked promotion of ONE shadow row into production. This function is never
-- called by the bulk reprocessor (repair-canonical-ledger-historical.ts) - it exists so that,
-- once a master-admin has reviewed a repair run's evidence, promotion happens through the same
-- kind of guarded, audited, atomic RPC as the existing daily certify_strategy_canonical_daily_ledger_c.
--
-- HARD SAFETY RULE: if the production row for (strategy_id, as_of_date) is already CERTIFIED,
-- this function refuses outright. It does not overwrite it, does not "supersede" it, does not
-- offer a force flag. Correcting an already-CERTIFIED historical value is a separate,
-- not-yet-designed business decision (a decertify-then-recertify workflow, or similar) that this
-- migration deliberately does not build - see the accompanying PR description.
--
-- When the production row does not exist, or exists as DRAFT, this function upserts the shadow
-- row's figures into production AS A DRAFT (never directly as CERTIFIED) - the existing
-- certify_strategy_canonical_daily_ledger_c RPC and its independent evidence checks remain the
-- only path from DRAFT to CERTIFIED, unchanged by this migration.
create or replace function public.promote_canonical_ledger_repair_row_c(
  p_repair_run_id uuid,
  p_strategy_id uuid,
  p_as_of_date date,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shadow public.strategy_canonical_daily_ledger_repair_c%rowtype;
  v_production public.strategy_canonical_daily_ledger_c%rowtype;
begin
  if nullif(trim(coalesce(p_actor, '')), '') is null then
    raise exception 'PROMOTION_ACTOR_REQUIRED';
  end if;

  select * into v_shadow
  from public.strategy_canonical_daily_ledger_repair_c
  where repair_run_id = p_repair_run_id and strategy_id = p_strategy_id and as_of_date = p_as_of_date
  for update;
  if not found then raise exception 'REPAIR_ROW_MISSING'; end if;
  if v_shadow.promoted_at is not null then
    return jsonb_build_object('status', 'ALREADY_PROMOTED', 'promoted_at', v_shadow.promoted_at, 'promoted_by', v_shadow.promoted_by);
  end if;

  select * into v_production
  from public.strategy_canonical_daily_ledger_c
  where strategy_id = p_strategy_id and as_of_date = p_as_of_date
  for update;

  if found and v_production.certification_status = 'CERTIFIED' then
    raise exception 'CERTIFIED_ROW_IMMUTABLE_REQUIRES_SEPARATE_RESTATEMENT_DECISION';
  end if;

  insert into public.strategy_canonical_daily_ledger_c (
    strategy_id, as_of_date, ledger_version, certification_status,
    securities_value_cents, continuity_cash_cents, complete_value_cents,
    leg_snapshot, period_metrics, source_evidence, source_evidence_sha256, calculation_notes
  ) values (
    v_shadow.strategy_id, v_shadow.as_of_date, v_shadow.ledger_version, 'DRAFT',
    v_shadow.securities_value_cents, v_shadow.continuity_cash_cents, v_shadow.complete_value_cents,
    v_shadow.leg_snapshot, v_shadow.period_metrics, v_shadow.source_evidence, v_shadow.source_evidence_sha256,
    v_shadow.calculation_notes || jsonb_build_object('promoted_from_repair_run', p_repair_run_id, 'promoted_by', p_actor)
  )
  on conflict (strategy_id, as_of_date) do update set
    ledger_version = excluded.ledger_version,
    certification_status = 'DRAFT',
    securities_value_cents = excluded.securities_value_cents,
    continuity_cash_cents = excluded.continuity_cash_cents,
    complete_value_cents = excluded.complete_value_cents,
    leg_snapshot = excluded.leg_snapshot,
    period_metrics = excluded.period_metrics,
    source_evidence = excluded.source_evidence,
    source_evidence_sha256 = excluded.source_evidence_sha256,
    calculation_notes = excluded.calculation_notes,
    updated_at = now()
  where public.strategy_canonical_daily_ledger_c.certification_status = 'DRAFT';

  update public.strategy_canonical_daily_ledger_repair_c
  set promoted_at = now(), promoted_by = p_actor
  where id = v_shadow.id;

  return jsonb_build_object(
    'status', 'PROMOTED_AS_DRAFT', 'strategy_id', p_strategy_id, 'as_of_date', p_as_of_date,
    'complete_value_cents', v_shadow.complete_value_cents
  );
end;
$$;

revoke all on function public.promote_canonical_ledger_repair_row_c(uuid,uuid,date,text)
  from public, anon, authenticated;
grant execute on function public.promote_canonical_ledger_repair_row_c(uuid,uuid,date,text)
  to service_role;

comment on table public.strategy_canonical_daily_ledger_repair_c is
  'Phase 2 shadow table for the canonical-ledger YTD chain-linking repair (PR #142). Holds reprocessed historical rows pending human review; never read by any production display path. Promotion into strategy_canonical_daily_ledger_c is exclusively via promote_canonical_ledger_repair_row_c, which refuses to touch an already-CERTIFIED production row.';
comment on function public.promote_canonical_ledger_repair_row_c(uuid,uuid,date,text) is
  'Explicit, human-invoked promotion of one reviewed repair-shadow row into production as DRAFT. Never called automatically. Refuses outright if the production row is already CERTIFIED.';

notify pgrst, 'reload schema';
commit;
