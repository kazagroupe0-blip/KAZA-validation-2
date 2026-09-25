-- F-01 M-A: a mobile-money payout is queued only after a provider
-- transaction reference exists. No other trigger behavior changes.

create or replace function public.queue_landlord_payout_after_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'pending'
     and new.status = 'confirmed'
     and new.method = 'mobile_money'
     and new.provider in ('mtn', 'moov', 'celtiis')
     and new.provider_ref is not null then
    insert into public.landlord_payouts (payment_id, landlord_id, amount)
    values (new.id, new.landlord_id, new.amount)
    on conflict (payment_id) do nothing;
  end if;

  return new;
end;
$$;

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.queue_landlord_payout_after_payment()'::regprocedure);
  if position('new.provider_ref is not null' in lower(v_def)) = 0 then
    raise exception 'F-01 M-A: provider_ref guard absent from queue_landlord_payout_after_payment';
  end if;
  if position('security definer' in lower(v_def)) = 0
     or position('set search_path to ''public''' in lower(v_def)) = 0 then
    raise exception 'F-01 M-A: security/search_path contract changed unexpectedly';
  end if;
end;
$$;
