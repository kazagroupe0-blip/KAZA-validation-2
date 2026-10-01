-- Shadow hardening: residence creation is draft-first and landlord-only.
--
-- The INSERT policy previously checked only owner_id = auth.uid(). An
-- authenticated user could therefore submit moderation/publication state in
-- the same INSERT and create a residence already marked approved/published.
-- That bypasses the canonical moderation workflow.
--
-- Regular application users may create only their own draft. Administrators
-- and service-role/database operations keep their existing privileges.

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

drop trigger if exists residences_before_insert_guard on public.residences;
create trigger residences_before_insert_guard
before insert on public.residences
for each row
execute function public.residences_guard_insert();

revoke execute on function public.residences_guard_insert() from public, anon, authenticated;