-- F-01 M-C: one provider transaction reference can belong to one payment.
-- NULL stays allowed because pending payments may not have a provider reference
-- before the external provider transaction exists.

do $$
begin
  if exists (
    select 1
      from public.payments
     where provider_ref is not null
     group by provider_ref
    having count(*) > 1
  ) then
    raise exception 'F-01 M-C: duplicate non-null provider_ref values already exist';
  end if;
end;
$$;

create unique index if not exists payments_provider_ref_unique_idx
  on public.payments (provider_ref)
  where provider_ref is not null;

do $$
begin
  if not exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and tablename = 'payments'
       and indexname = 'payments_provider_ref_unique_idx'
  ) then
    raise exception 'F-01 M-C: unique provider_ref index was not created';
  end if;
end;
$$;
