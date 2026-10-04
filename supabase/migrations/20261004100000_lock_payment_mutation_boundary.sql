-- 20261004100000_lock_payment_mutation_boundary.sql
-- P0 / F01: move landlord payment confirmation/rejection behind server-owned RPCs.
--
-- Invariant:
--   authenticated clients must never mutate payments directly.
--   Financial provider paths keep their service_role write capability.
--   The RPCs own authorization + transition state + audit fields.
--
-- This is intentionally additive and leaves the existing financial guards intact.

-- 1. Remove the client-side UPDATE capability while preserving service_role.
revoke update on public.payments from public, anon, authenticated;

-- 2. Defense in depth: even if a later migration accidentally re-grants UPDATE,
--    an authenticated direct table mutation is still rejected unless it comes
--    through one of the two controlled RPCs below.
create or replace function public.payments_direct_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('kaza.payment_mutation', true), '') not in ('confirm', 'reject') then
    raise exception 'Modification directe des paiements interdite — utilisez le workflow sécurisé'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists payments_a_before_update_access_guard on public.payments;
create trigger payments_a_before_update_access_guard
  before update on public.payments
  for each row
  execute function public.payments_direct_update_guard();

-- 3. Controlled confirmation workflow for cash payments.
create or replace function public.confirm_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_payment public.payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentification requise' using errcode = '28000';
  end if;

  select *
    into v_payment
    from public.payments
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'Paiement introuvable' using errcode = 'P0002';
  end if;

  if v_payment.landlord_id is distinct from auth.uid()
     and not public.is_admin() then
    raise exception 'Vous ne pouvez pas confirmer ce paiement' using errcode = '42501';
  end if;

  if v_payment.method <> 'cash' or v_payment.provider <> 'cash' then
    raise exception 'Les paiements Mobile Money sont confirmés uniquement par le fournisseur de paiement'
      using errcode = '42501';
  end if;

  -- Idempotent retry: once confirmed, the workflow is already complete.
  if v_payment.status = 'confirmed' then
    return;
  end if;

  if v_payment.status <> 'pending' then
    raise exception 'Ce paiement ne peut plus être confirmé' using errcode = 'P0001';
  end if;

  perform set_config('kaza.payment_mutation', 'confirm', true);

  update public.payments
     set status = 'confirmed',
         confirmed_by = auth.uid(),
         confirmed_at = now()
   where id = p_payment_id;
end;
$function$;

revoke execute on function public.confirm_payment(uuid) from public, anon, authenticated;
grant execute on function public.confirm_payment(uuid) to authenticated;

-- 4. Controlled rejection workflow for cash payments.
create or replace function public.reject_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_payment public.payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentification requise' using errcode = '28000';
  end if;

  select *
    into v_payment
    from public.payments
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'Paiement introuvable' using errcode = 'P0002';
  end if;

  if v_payment.landlord_id is distinct from auth.uid()
     and not public.is_admin() then
    raise exception 'Vous ne pouvez pas rejeter ce paiement' using errcode = '42501';
  end if;

  if v_payment.method <> 'cash' or v_payment.provider <> 'cash' then
    raise exception 'Les paiements Mobile Money sont rejetés uniquement par le fournisseur de paiement'
      using errcode = '42501';
  end if;

  -- Idempotent retry.
  if v_payment.status = 'rejected' then
    return;
  end if;

  if v_payment.status <> 'pending' then
    raise exception 'Ce paiement ne peut plus être rejeté' using errcode = 'P0001';
  end if;

  perform set_config('kaza.payment_mutation', 'reject', true);

  update public.payments
     set status = 'rejected'
   where id = p_payment_id;
end;
$function$;

revoke execute on function public.reject_payment(uuid) from public, anon, authenticated;
grant execute on function public.reject_payment(uuid) to authenticated;

-- 5. Structural assertions: fail the migration if the boundary is not actually installed.
do $$
declare
  v_update_grants integer;
begin
  select count(*)
    into v_update_grants
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'payments'
     and grantee in ('anon', 'authenticated')
     and privilege_type = 'UPDATE';

  if v_update_grants <> 0 then
    raise exception 'F01: UPDATE direct reste accordé sur payments aux rôles clients';
  end if;

  if to_regprocedure('public.confirm_payment(uuid)') is null then
    raise exception 'F01: confirm_payment(uuid) absent';
  end if;

  if to_regprocedure('public.reject_payment(uuid)') is null then
    raise exception 'F01: reject_payment(uuid) absent';
  end if;

  if not exists (
    select 1
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'payments'
       and tg.tgname = 'payments_a_before_update_access_guard'
       and not tg.tgisinternal
  ) then
    raise exception 'F01: trigger payments_a_before_update_access_guard absent';
  end if;
end;
$$;
