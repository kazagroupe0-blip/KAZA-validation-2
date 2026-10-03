-- Restore the intended runtime grants for public residence details and visit agreement.
--
-- get_residence: public listing detail is intentionally callable by anon;
-- the function itself still enforces that only published/verified/approved/free
-- residences are returned to non-owners.
--
-- agree_visit: the web client calls this RPC as an authenticated participant;
-- authorization remains enforced inside the SECURITY DEFINER function.

revoke execute on function public.get_residence(uuid) from public;
grant execute on function public.get_residence(uuid) to anon, authenticated, service_role;

revoke execute on function public.agree_visit(uuid, boolean, text) from public;
grant execute on function public.agree_visit(uuid, boolean, text) to service_role;
