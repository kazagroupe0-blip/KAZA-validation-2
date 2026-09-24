-- Final cleanup: keep one canonical UPDATE policy on profiles.
-- The canonical policy is established by 20260923220000_profiles_update_policy_convergence.sql.
-- This migration only removes superseded policy names; it does not recreate the
-- canonical policy, avoiding duplicate-policy failures during fresh db resets.
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;
