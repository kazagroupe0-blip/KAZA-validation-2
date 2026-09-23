-- Final cleanup: keep one canonical UPDATE policy on profiles.
-- The canonical policy also covers admins; sensitive columns remain protected
-- by profiles_guard_sensitive().
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;

create policy profiles_update
  on public.profiles
  for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());
