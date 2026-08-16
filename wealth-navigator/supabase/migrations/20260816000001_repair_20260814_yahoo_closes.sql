begin;

-- Repair the only two exact-close differences found by the 2026-08-16
-- read-only canonical certification audit.
--
-- Yahoo chart evidence (JSE .JO instruments, currency ZAc):
--   SYGEMF.JO  2026-08-14  3085 cents
--   STXNDQ.JO  2026-08-14 27583 cents
--
-- This migration is deliberately narrow and idempotent. It refuses to update
-- anything unless the two physical rows still have the IDs, securities,
-- symbols, date and previous prices independently inspected before authoring.
-- It does not modify return ledgers, certification, holdings, rebalances,
-- owner cash or the 8% execution reserve.
do $$
declare
  v_sygemf_id constant uuid := 'b4d775c7-4b0f-4f8e-8486-8bc413b05a1f';
  v_sygemf_security_id constant uuid := '42eaf9df-92df-4ac4-af4c-dc5c9aed6212';
  v_stxndq_id constant uuid := '56bf4e3b-f900-4cbb-89c6-f3798cde921a';
  v_stxndq_security_id constant uuid := 'f407fd28-a74b-4f70-865e-7d7acfd899b0';
  v_already_repaired integer;
  v_expected_old integer;
  v_verified integer;
begin
  select count(*)::integer
    into v_already_repaired
    from public.stock_returns_c
   where as_of_date = date '2026-08-14'
     and (
       (id = v_sygemf_id and security_id = v_sygemf_security_id
        and symbol = 'SYGEMF.JO' and current_price = 3085)
       or
       (id = v_stxndq_id and security_id = v_stxndq_security_id
        and symbol = 'STXNDQ.JO' and current_price = 27583)
     );

  if v_already_repaired = 2 then
    return;
  end if;

  select count(*)::integer
    into v_expected_old
    from public.stock_returns_c
   where as_of_date = date '2026-08-14'
     and (
       (id = v_sygemf_id and security_id = v_sygemf_security_id
        and symbol = 'SYGEMF.JO' and current_price = 3081)
       or
       (id = v_stxndq_id and security_id = v_stxndq_security_id
        and symbol = 'STXNDQ.JO' and current_price = 27630)
     );

  if v_expected_old <> 2 then
    raise exception
      '14-Aug close repair blocked: expected two unchanged source rows, found %',
      v_expected_old;
  end if;

  update public.stock_returns_c
     set current_price = 3085,
         fetched_at = timestamptz '2026-08-16 07:13:43.399+00'
   where id = v_sygemf_id
     and security_id = v_sygemf_security_id
     and symbol = 'SYGEMF.JO'
     and as_of_date = date '2026-08-14'
     and current_price = 3081;

  update public.stock_returns_c
     set current_price = 27583,
         fetched_at = timestamptz '2026-08-16 07:13:43.399+00'
   where id = v_stxndq_id
     and security_id = v_stxndq_security_id
     and symbol = 'STXNDQ.JO'
     and as_of_date = date '2026-08-14'
     and current_price = 27630;

  select count(*)::integer
    into v_verified
    from public.stock_returns_c
   where as_of_date = date '2026-08-14'
     and (
       (id = v_sygemf_id and security_id = v_sygemf_security_id
        and symbol = 'SYGEMF.JO' and current_price = 3085)
       or
       (id = v_stxndq_id and security_id = v_stxndq_security_id
        and symbol = 'STXNDQ.JO' and current_price = 27583)
     );

  if v_verified <> 2 then
    raise exception '14-Aug close repair verification failed; transaction rolled back';
  end if;
end
$$;

commit;
