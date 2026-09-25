-- F-01/F-26 M-B1: expose business operations through SECURITY DEFINER
-- RPCs instead of direct client confirmation/rejection updates.

create or replace function public.confirm_cash_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Non authentifié' using errcode = '28000';
  end if;

  select *
    into v_payment
    from public.payments
   where id = p_payment_id
   for update;

  if v_payment.id is null then
    raise exception 'Paiement introuvable' using errcode = 'P0002';
  end if;

  if v_payment.landlord_id <> auth.uid() and not public.is_admin() then
    raise exception 'Seul le bailleur confirme ce paiement' using errcode = '42501';
  end if;

  if v_payment.method <> 'cash' then
    raise exception 'Seuls les paiements espèces se confirment par cette voie' using errcode = '42501';
  end if;

  if v_payment.status = 'confirmed' then
    if v_payment.confirmed_by is not distinct from auth.uid() then
      return;
    end if;
    raise exception 'Ce paiement est déjà confirmé' using errcode = 'P0001';
  end if;

  if v_payment.status <> 'pending' then
    raise exception 'Ce paiement n''est plus en attente' using errcode = 'P0001';
  end if;

  update public.payments
     set status = 'confirmed',
         confirmed_at = now(),
         confirmed_by = auth.uid()
   where id = p_payment_id;
end;
$$;

revoke execute on function public.confirm_cash_payment(uuid) from public, anon;
grant execute on function public.confirm_cash_payment(uuid) to authenticated;

create or replace function public.reject_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Non authentifié' using errcode = '28000';
  end if;

  select *
    into v_payment
    from public.payments
   where id = p_payment_id
   for update;

  if v_payment.id is null then
    raise exception 'Paiement introuvable' using errcode = 'P0002';
  end if;

  if v_payment.landlord_id <> auth.uid() and not public.is_admin() then
    raise exception 'Seul le bailleur rejette ce paiement' using errcode = '42501';
  end if;

  if v_payment.status = 'rejected' then
    return;
  end if;

  if v_payment.status <> 'pending' then
    raise exception 'Ce paiement n''est plus en attente' using errcode = 'P0001';
  end if;

  update public.payments
     set status = 'rejected'
   where id = p_payment_id;
end;
$$;

revoke execute on function public.reject_payment(uuid) from public, anon;
grant execute on function public.reject_payment(uuid) to authenticated;

do $$
begin
  if not has_function_privilege('authenticated', 'public.confirm_cash_payment(uuid)', 'EXECUTE') then
    raise exception 'F-01/F-26 M-B1: authenticated lacks confirm_cash_payment EXECUTE';
  end if;
  if has_function_privilege('anon', 'public.confirm_cash_payment(uuid)', 'EXECUTE') then
    raise exception 'F-01/F-26 M-B1: anon can execute confirm_cash_payment';
  end if;
  if not has_function_privilege('authenticated', 'public.reject_payment(uuid)', 'EXECUTE') then
    raise exception 'F-01/F-26 M-B1: authenticated lacks reject_payment EXECUTE';
  end if;
  if has_function_privilege('anon', 'public.reject_payment(uuid)', 'EXECUTE') then
    raise exception 'F-01/F-26 M-B1: anon can execute reject_payment';
  end if;
end;
$$;
