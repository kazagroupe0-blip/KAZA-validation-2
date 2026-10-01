-- 20261001082000_unique_active_lease_per_residence.sql
-- Enforce the invariant already present in validation Supabase B:
-- at most one active lease per residence.
create unique index if not exists leases_one_active_per_residence
  on public.leases (residence_id)
  where status = 'active';

do $$
begin
  if not exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and indexname = 'leases_one_active_per_residence'
  ) then
    raise exception 'leases_one_active_per_residence index is missing';
  end if;
end
$$;