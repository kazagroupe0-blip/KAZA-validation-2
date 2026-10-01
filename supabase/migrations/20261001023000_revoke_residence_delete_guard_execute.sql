-- 20261001023000_revoke_residence_delete_guard_execute.sql
-- Internal trigger helper: never expose as a callable PostgREST RPC.
revoke execute on function public.residences_guard_delete()
from public, anon, authenticated;