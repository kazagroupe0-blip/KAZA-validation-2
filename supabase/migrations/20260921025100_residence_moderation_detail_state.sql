-- Align get_residence with the residence moderation lifecycle.
-- Owners need the persisted moderation state/reason after a reload; public
-- callers still receive only residences matching the canonical publication contract.

create or replace function public.get_residence(p_residence_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.residences%rowtype;
  v_owner jsonb;
  v_rating numeric;
  v_rating_count int;
  v_result jsonb;
begin
  select * into v_row
  from public.residences
  where id = p_residence_id;

  if v_row.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if not (
    (
      v_row.is_published
      and v_row.is_verified
      and v_row.moderation_status = 'approved'
      and v_row.status = 'libre'
    )
    or v_row.owner_id = auth.uid()
    or public.is_admin()
  ) then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'id', p.id,
    'full_name', p.full_name,
    'avatar_url', p.avatar_url,
    'is_premium', p.is_premium,
    'is_verified_landlord', p.is_verified_landlord
  )
  into v_owner
  from public.profiles p
  where p.id = v_row.owner_id;

  select coalesce(round(avg(rating)::numeric, 1), 0), count(*)
    into v_rating, v_rating_count
    from public.reviews
   where residence_id = p_residence_id;

  v_result := jsonb_build_object(
    'id', v_row.id,
    'owner_id', v_row.owner_id,
    'title', v_row.title,
    'description', v_row.description,
    'type', v_row.type,
    'price_monthly', v_row.price_monthly,
    'deposit', v_row.deposit,
    'bedrooms', v_row.bedrooms,
    'bathrooms', v_row.bathrooms,
    'surface', v_row.surface,
    'address', v_row.address,
    'city', v_row.city,
    'zone', v_row.zone,
    'lat', v_row.lat,
    'lng', v_row.lng,
    'photos', v_row.photos,
    'status', v_row.status,
    'is_published', v_row.is_published,
    'is_verified', v_row.is_verified,
    'moderation_status', v_row.moderation_status,
    'moderation_reason', v_row.moderation_reason,
    'moderated_at', v_row.moderated_at,
    'views_count', v_row.views_count,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at,
    'features', v_row.features,
    'standing_level', public.residence_standing(v_row.features),
    'owner', v_owner,
    'distance_km', null,
    'rating_avg', v_rating,
    'rating_count', v_rating_count
  );

  return v_result;
end;
$$;

revoke execute on function public.get_residence(uuid) from public, anon;
grant execute on function public.get_residence(uuid) to authenticated;
