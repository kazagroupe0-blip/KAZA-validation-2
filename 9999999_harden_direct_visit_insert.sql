-- KAZA: direct visit creation is RPC-only.
--
-- 9998_restore_table_grants.sql intentionally restores broad table grants for
-- Supabase Cloud parity. That restoration must not reopen the direct visit
-- INSERT surface. propose_visit() remains the only authenticated application
-- entry point for creating visits.

drop policy if exists visits_insert_tenant on public.visits;

revoke insert on table public.visits from anon, authenticated;
