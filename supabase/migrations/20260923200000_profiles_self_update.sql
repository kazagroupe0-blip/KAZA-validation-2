-- Allow an authenticated user to update only their own profile row.
-- Sensitive fields (role, premium, APDP consent) remain protected by
-- profiles_guard_sensitive(); onboarding_completed is computed by its own trigger.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
