-- 20260920262000_landlord_payout_rpc_acl.sql
-- Server-side payout processing uses service_role through PostgREST.
-- Grant only the existing admin retry RPC execution privilege; the RPC
-- itself still enforces admin/service-role authorization.

grant execute on function public.admin_retry_landlord_payout(uuid) to service_role;
