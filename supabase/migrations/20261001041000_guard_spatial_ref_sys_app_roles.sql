-- Shadow hardening: protect the PostGIS reference catalog from app roles.
--
-- The PostGIS extension owns public.spatial_ref_sys, so ordinary REVOKE
-- statements do not alter its extension-managed ACL in the hosted environment.
-- B was therefore still allowing anon/authenticated to modify/truncate the
-- catalog. KAZA never needs application roles to write this reference data.
--
-- A SECURITY DEFINER trigger owned by the database application owner provides
-- a second barrier: it rejects DML/TRUNCATE when the JWT role is anon or
-- authenticated, while leaving postgres/service-role/extension operations
-- untouched. The trigger is intentionally independent of RLS.

create or replace function public.spatial_ref_sys_app_role_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'Le catalogue PostGIS spatial_ref_sys est en lecture seule pour les rôles applicatifs'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$function$;

drop trigger if exists spatial_ref_sys_app_role_guard_dml on public.spatial_ref_sys;
create trigger spatial_ref_sys_app_role_guard_dml
before insert or update or delete on public.spatial_ref_sys
for each row
execute function public.spatial_ref_sys_app_role_guard();

drop trigger if exists spatial_ref_sys_app_role_guard_truncate on public.spatial_ref_sys;
create trigger spatial_ref_sys_app_role_guard_truncate
before truncate on public.spatial_ref_sys
for each statement
execute function public.spatial_ref_sys_app_role_guard();

revoke execute on function public.spatial_ref_sys_app_role_guard() from public, anon, authenticated;