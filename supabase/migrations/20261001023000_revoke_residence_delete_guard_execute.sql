-- 20261001023000_revoke_residence_delete_guard_execute.sql
-- Internal trigger helper: never expose as a callable PostgREST RPC.
-- The helper may be created later in the ordered migration chain, so this
-- migration must remain safe on a fresh database. The convergence migration
-- reasserts the revoke after the function is defined.
do $$
begin
  if to_regprocedure('public.residences_guard_delete()') is not null then
    execute 'revoke execute on function public.residences_guard_delete() from public, anon, authenticated';
  end if;
end
$$;