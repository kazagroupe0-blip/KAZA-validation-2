-- Dedicated admin-only listing RPC for the operations console.
-- Keeps internal residence rows available without widening public SELECT grants.
create or replace function public.list_admin_residences(
  p_limit int default 100,
  p_offset int default 0
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 100));
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.is_admin() then
    raise exception 'Accès réservé aux administrateurs' using errcode = '42501';
  end if;

  return query
  select
    to_jsonb(r)
    || jsonb_build_object(
      'owner',
      jsonb_build_object(
        'id', p.id,
        'full_name', p.full_name
      )
    )
  from public.residences r
  left join public.profiles p on p.id = r.owner_id
  order by r.created_at desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke execute on function public.list_admin_residences(int, int) from public, anon;
grant execute on function public.list_admin_residences(int, int) to authenticated;
