-- F-01/F-26 M-B2: direct authenticated payment UPDATE may reject a pending
-- payment, but cannot transition any payment to confirmed. Confirmation is
-- exclusively handled by confirm_cash_payment() or trusted service_role flows.

drop policy if exists payments_update_landlord on public.payments;

create policy payments_update_landlord
  on public.payments
  for update
  using (landlord_id = auth.uid() or is_admin())
  with check (
    (landlord_id = auth.uid() or is_admin())
    and status = 'rejected'::payment_status
  );

do $$
declare
  v_pol record;
begin
  select *
    into v_pol
    from pg_policy
   where polrelid = 'public.payments'::regclass
     and polname = 'payments_update_landlord';

  if v_pol.oid is null then
    raise exception 'F-01/F-26 M-B2: payments_update_landlord was not created';
  end if;

  if position('status = ''rejected''::public.payment_status' in lower(pg_get_expr(v_pol.polwithcheck, v_pol.polrelid))) = 0
     and position('status = ''rejected''::payment_status' in lower(pg_get_expr(v_pol.polwithcheck, v_pol.polrelid))) = 0 then
    raise exception 'F-01/F-26 M-B2: policy WITH CHECK does not constrain status to rejected';
  end if;
end;
$$;
