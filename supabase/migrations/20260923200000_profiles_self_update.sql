-- Allow authenticated users to update only their own profile row.
-- Sensitive fields remain protected by profiles_guard_sensitive().
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
