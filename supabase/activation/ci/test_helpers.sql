-- Outils de TEST uniquement (CI jetable, base locale). NE JAMAIS appliquer à un projet distant.
-- Simule un échec de suppression Storage pour des noms d'objets listés dans
-- public.ci_f05_blocked_names : un DELETE sur storage.objects (donc l'API Storage remove())
-- échoue tant que le nom y figure. Le service_role du test insère / retire les noms.
create table if not exists public.ci_f05_blocked_names (
  name text primary key
);

alter table public.ci_f05_blocked_names enable row level security;
revoke all on table public.ci_f05_blocked_names from public, anon, authenticated;
grant all on table public.ci_f05_blocked_names to service_role;

create or replace function public.ci_f05_block_delete_fn()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from public.ci_f05_blocked_names b where b.name = old.name) then
    raise exception 'CI-only simulated storage deletion failure';
  end if;
  return old;
end;
$$;

revoke all on function public.ci_f05_block_delete_fn() from public, anon, authenticated;

drop trigger if exists ci_f05_block_delete on storage.objects;
create trigger ci_f05_block_delete
  before delete on storage.objects
  for each row
  execute function public.ci_f05_block_delete_fn();
