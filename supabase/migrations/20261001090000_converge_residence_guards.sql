-- 20261001090000_converge_residence_guards.sql
-- Converge production A with the validated residence safety guards present in B.
-- Source of truth: effective function/trigger definitions observed in validation B.
--
-- Deliberately leaves rls_auto_enable() untouched: it is an extra A-side defense
-- and is not required for the residence-guard convergence.

create or replace function public.residences_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role public.user_role;
begin
  if auth.role() = 'service_role' or auth.role() is null then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'Non authentifié' using errcode = '42501';
  end if;

  select role
    into v_role
    from public.profiles
   where id = auth.uid();

  if v_role = 'admin' then
    return new;
  end if;

  if v_role <> 'bailleur' then
    raise exception 'Seuls les bailleurs peuvent créer une résidence'
      using errcode = '42501';
  end if;

  if new.owner_id is distinct from auth.uid() then
    raise exception 'Le propriétaire de la résidence est invalide'
      using errcode = '42501';
  end if;

  new.owner_id := auth.uid();
  new.status := 'libre';
  new.is_published := false;
  new.is_verified := false;
  new.moderation_status := 'draft';
  new.moderation_reason := null;
  new.moderated_at := null;
  new.views_count := 0;

  return new;
end;
$function$;

create or replace function public.residences_guard_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.role() = 'service_role'
     or auth.role() is null
     or public.is_admin()
     or current_setting('kaza.internal_residence_transition', true) = '1' then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception 'Le statut de disponibilité est géré par le workflow KAZA'
      using errcode = '42501';
  end if;

  new.status := old.status;
  new.is_verified := old.is_verified;
  new.is_published := old.is_published;
  new.owner_id := old.owner_id;
  new.moderation_status := old.moderation_status;
  new.moderation_reason := old.moderation_reason;
  new.moderated_at := old.moderated_at;

  if old.moderation_status = 'approved'
     and (
       new.title is distinct from old.title
       or new.description is distinct from old.description
       or new.type is distinct from old.type
       or new.price_monthly is distinct from old.price_monthly
       or new.deposit is distinct from old.deposit
       or new.bedrooms is distinct from old.bedrooms
       or new.bathrooms is distinct from old.bathrooms
       or new.surface is distinct from old.surface
       or new.address is distinct from old.address
       or new.city is distinct from old.city
       or new.zone is distinct from old.zone
       or new.lat is distinct from old.lat
       or new.lng is distinct from old.lng
       or new.geom is distinct from old.geom
       or new.photos is distinct from old.photos
       or new.features is distinct from old.features
     ) then
    new.is_published := false;
    new.is_verified := false;
    new.moderation_status := 'draft';
    new.moderation_reason := null;
    new.moderated_at := null;
  end if;

  return new;
end;
$function$;

create or replace function public.residences_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.role() = 'service_role' or auth.role() is null then
    return old;
  end if;

  if old.status <> 'libre' then
    raise exception 'Cette résidence ne peut pas être supprimée dans son état actuel'
      using errcode = '42501';
  end if;

  if exists (
    select 1
      from public.leases l
     where l.residence_id = old.id
  ) then
    raise exception 'Cette résidence possède un historique de bail et ne peut pas être supprimée'
      using errcode = '23503';
  end if;

  return old;
end;
$function$;

drop trigger if exists residences_before_insert_guard on public.residences;
create trigger residences_before_insert_guard
before insert on public.residences
for each row
execute function public.residences_guard_insert();

drop trigger if exists residences_before_delete_guard on public.residences;
create trigger residences_before_delete_guard
before delete on public.residences
for each row
execute function public.residences_guard_delete();

drop trigger if exists residences_before_insert_moderation on public.residences;
drop function if exists public.enforce_residence_insert_moderation();

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'residences_before_insert_guard'
       and tgrelid = 'public.residences'::regclass
       and not tgisinternal
  ) then
    raise exception 'Residence insert guard trigger missing';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'residences_before_delete_guard'
       and tgrelid = 'public.residences'::regclass
       and not tgisinternal
  ) then
    raise exception 'Residence delete guard trigger missing';
  end if;

  if position('Le statut de disponibilité est géré par le workflow KAZA'
              in pg_get_functiondef('public.residences_guard_owner()'::regprocedure)) = 0 then
    raise exception 'Residence owner status-forgery guard missing';
  end if;

  if to_regprocedure('public.enforce_residence_insert_moderation()') is not null then
    raise exception 'Legacy residence insert moderation helper still exists';
  end if;
end
$$;