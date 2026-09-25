
-- is_admin() is intentionally SECURITY DEFINER because it is called by RLS
-- policies; the policy engine invokes it in the anon/authenticated request
-- context. Revoke would make the RLS policy itself fail with 42501.
grant execute on function public.is_admin() to anon, authenticated;
