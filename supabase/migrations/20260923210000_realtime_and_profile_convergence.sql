-- 20260923210000_realtime_and_profile_convergence.sql
-- Final convergence guard:
-- 1. every authenticated user can update only their own profile row;
-- 2. Realtime publication explicitly covers the rows consumed by the web app.
--
-- No destructive data change. All operations are idempotent.

drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'visits'
  ) then
    alter publication supabase_realtime add table public.visits;
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;
