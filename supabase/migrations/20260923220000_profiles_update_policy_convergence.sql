-- Converge profile UPDATE RLS into one canonical policy.
-- Sensitive fields remain protected by profiles_guard_sensitive().
--
-- This migration is object-idempotent: an existing policy is altered in place;
-- it is never assumed absent. That makes fresh resets and repeated application
-- safe even when an earlier migration or environment already created the name.
do $$
begin
  drop policy if exists profiles_update_own on public.profiles;
  drop policy if exists profiles_update_self on public.profiles;
  drop policy if exists profiles_update_admin on public.profiles;

  if exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'profiles'
       and policyname = 'profiles_update'
  ) then
    alter policy profiles_update on public.profiles
      using (auth.uid() = id or public.is_admin())
      with check (auth.uid() = id or public.is_admin());
  else
    create policy profiles_update
      on public.profiles
      for update
      using (auth.uid() = id or public.is_admin())
      with check (auth.uid() = id or public.is_admin());
  end if;
end
$$;
