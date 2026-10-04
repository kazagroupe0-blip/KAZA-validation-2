-- KAZA: align list_reviews with the validated public-visibility contract.
--
-- Public callers may read reviews only for a residence that is currently
-- published, verified, approved and free. Owners/admins may read their own
-- or administratively visible reviews. Never expose the tenant identity from
-- this RPC.

create or replace function public.list_reviews(p_residence_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_json jsonb;
  v_visible boolean;
begin
  select exists (
    select 1
      from public.residences r
     where r.id = p_residence_id
       and (
         (
           r.is_published = true
           and r.is_verified = true
           and r.moderation_status = 'approved'
           and r.status = 'libre'
         )
         or r.owner_id = auth.uid()
         or public.is_admin()
       )
  )
    into v_visible;

  if not v_visible then
    return jsonb_build_object(
      'average', 0,
      'count', 0,
      'reviews', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'average', coalesce(round(avg(rv.rating)::numeric, 1), 0),
    'count', count(*),
    'reviews', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', rv.id,
          'residence_id', rv.residence_id,
          'rating', rv.rating,
          'comment', rv.comment,
          'created_at', rv.created_at
        )
        order by rv.created_at desc
      ),
      '[]'::jsonb
    )
  )
    into v_json
    from public.reviews rv
   where rv.residence_id = p_residence_id;

  return v_json;
end;
$function$;

revoke execute on function public.list_reviews(uuid) from public, authenticated;
grant execute on function public.list_reviews(uuid) to anon, authenticated, service_role;