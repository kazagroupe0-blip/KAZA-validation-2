
-- ============================================================================
-- 20260920073000_security_definer_hardening.sql
-- Final security hardening:
--   - pin mutable search_path on trigger/helper functions
--   - prevent authenticated users from altering notification push state
--   - remove RPC EXECUTE exposure from trigger/event-trigger functions
--   - restrict admin-only/intended-authenticated helpers from anon
--   - remove direct anon/authenticated execution of PostGIS extent helpers
-- ============================================================================

-- 1) Pin search_path on functions flagged by Supabase's security advisor.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.messages_guard_read_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.conversation_id := old.conversation_id;
  new.sender_id := old.sender_id;
  new.body := old.body;
  new.attachments := old.attachments;
  new.kind := old.kind;
  new.created_at := old.created_at;
  return new;
end;
$$;

create or replace function public.payments_guard_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'confirmed' then
    raise exception 'Un paiement confirmé est immuable' using errcode = '42501';
  end if;
  if new.status = 'confirmed' and new.confirmed_at is null then
    raise exception 'confirmed_at requis pour confirmer' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.notifications_guard_read_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.user_id := old.user_id;
  new.title := old.title;
  new.body := old.body;
  new.type := old.type;
  new.data := old.data;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- 2) Important: current_user is the SECURITY DEFINER owner (postgres), so it
-- cannot distinguish a normal authenticated update from service_role here.
-- auth.role() is the correct request-context check.
create or replace function public.notifications_push_columns_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and auth.role() is not null then
    new.push_sent_at := old.push_sent_at;
    new.push_claimed_at := old.push_claimed_at;
  end if;
  return new;
end;
$$;

-- 3) Trigger/event-trigger functions are implementation details, not RPC APIs.
-- Revoke EXECUTE from the public API roles. Triggers invoked by PostgreSQL
-- continue to work under their owner's privileges.
do $$
declare
  r record;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           t.typname as return_type
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type t on t.oid = p.prorettype
     where n.nspname = 'public'
       and t.oid in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
  loop
    execute format(
      'revoke execute on function public.%I(%s) from public, anon, authenticated',
      r.proname, r.args
    );
  end loop;
end;
$$;

-- Legacy/extension helper overloads should not be callable as arbitrary RPCs.
revoke execute on function public.st_estimatedextent(text, text) from public, anon, authenticated;
revoke execute on function public.st_estimatedextent(text, text, text) from public, anon, authenticated;
revoke execute on function public.st_estimatedextent(text, text, text, boolean) from public, anon, authenticated;

-- 4) These helpers are not needed as anonymous RPC endpoints.
-- search_residences remains anonymous-capable by design.
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.get_residence(uuid) from public, anon;
revoke execute on function public.list_reviews(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.get_residence(uuid) to authenticated;
grant execute on function public.list_reviews(uuid) to authenticated;

-- 5) Explicit post-checks.
do $$
begin
  if position('set search_path to ''public''' in lower(pg_get_functiondef(
       'public.touch_updated_at()'::regprocedure
     ))) = 0 then
    raise exception 'touch_updated_at search_path non verrouille';
  end if;

  if position('set search_path to ''public''' in lower(pg_get_functiondef(
       'public.notifications_push_columns_guard()'::regprocedure
     ))) = 0 then
    raise exception 'notifications_push_columns_guard search_path non verrouille';
  end if;

  if position('auth.role()' in pg_get_functiondef(
       'public.notifications_push_columns_guard()'::regprocedure
     )) = 0 then
    raise exception 'notifications_push_columns_guard utilise encore current_user';
  end if;

  if has_function_privilege('anon', 'public.get_residence(uuid)', 'EXECUTE') then
    raise exception 'get_residence reste executable par anon';
  end if;

  if has_function_privilege('anon', 'public.list_reviews(uuid)', 'EXECUTE') then
    raise exception 'list_reviews reste executable par anon';
  end if;

  raise notice 'OK : search_path pins, trigger RPC exposure removed, push columns protected, anon restrictions applied.';
end;
$$;
