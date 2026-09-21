-- 20260921013000_residence_publication_contract.sql
-- Keep public discovery, detail, and first contact on one canonical contract:
-- approved + published + verified + libre.

drop policy if exists residences_select on public.residences;
drop policy if exists residences_select_admin on public.residences;

create policy residences_select
  on public.residences
  for select
  using (
    (
      is_published = true
      and is_verified = true
      and moderation_status = 'approved'
      and status = 'libre'
    )
    or owner_id = auth.uid()
    or (select public.is_admin())
  );

create or replace function public.search_residences(
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_km double precision default 10,
  p_type public.residence_type default null,
  p_max_price numeric default null,
  p_q text default null,
  p_city text default null,
  p_zone text default null,
  p_limit int default 40,
  p_offset int default 0
)
returns table (
  id uuid, title text, description text, type public.residence_type,
  price_monthly numeric, deposit numeric, bedrooms int, bathrooms int,
  surface numeric, city text, zone text, address text,
  lat double precision, lng double precision, photos text[], status public.residence_status,
  distance_km double precision,
  owner_id uuid, owner_full_name text, owner_is_verified_landlord boolean, owner_is_premium boolean,
  features jsonb, standing_level text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_point geometry := null;
begin
  if p_lat is not null and p_lng is not null then
    v_point := st_setsrid(st_makepoint(p_lng, p_lat), 4326);
  end if;

  return query
  select
    r.id, r.title, r.description, r.type,
    r.price_monthly, r.deposit, r.bedrooms, r.bathrooms,
    r.surface, r.city, r.zone, r.address,
    r.lat, r.lng, r.photos, r.status,
    case when v_point is not null and r.geom is not null
         then st_distance(r.geom::geography, v_point::geography) / 1000.0
         else null end,
    r.owner_id, p.full_name, p.is_verified_landlord, p.is_premium,
    r.features, public.residence_standing(r.features)
  from public.residences r
  left join public.profiles p on p.id = r.owner_id
  where r.is_published = true
    and r.is_verified = true
    and r.moderation_status = 'approved'
    and r.status = 'libre'
    and (p_type is null or r.type = p_type)
    and (p_max_price is null or r.price_monthly <= p_max_price)
    and (p_city is null or r.city ilike p_city)
    and (p_zone is null or r.zone ilike p_zone)
    and (p_q is null or (r.title ilike '%' || p_q || '%' or r.description ilike '%' || p_q || '%'))
    and (v_point is null or r.geom is null
         or st_dwithin(r.geom::geography, v_point::geography, p_radius_km * 1000))
  order by
    case when v_point is not null and r.geom is not null
         then r.geom <-> v_point else null end asc nulls last,
    r.created_at desc
  limit p_limit offset p_offset;
end;
$$;

create or replace function public.get_residence(p_residence_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v_row public.residences%rowtype;
  v_owner jsonb;
  v_rating numeric;
  v_rating_count int;
  v_result jsonb;
begin
  select * into v_row from public.residences where id = p_residence_id;
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

create or replace function public.open_conversation(p_residence_id uuid)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_role public.user_role;
  v_id uuid;
begin
  select role into v_role
  from public.profiles
  where id = auth.uid();

  if v_role is distinct from 'locataire'::public.user_role then
    raise exception 'Seuls les locataires peuvent contacter un bailleur' using errcode = '42501';
  end if;

  select owner_id into v_owner
    from public.residences
   where id = p_residence_id
     and is_published = true
     and is_verified = true
     and moderation_status = 'approved'
     and status = 'libre';

  if v_owner is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if v_owner = auth.uid() then
    raise exception 'Vous ne pouvez pas vous écrire à vous-même' using errcode = 'P0001';
  end if;

  select id into v_id
    from public.conversations
   where residence_id = p_residence_id
     and tenant_id = auth.uid();

  if v_id is null then
    insert into public.conversations (residence_id, landlord_id, tenant_id)
    values (p_residence_id, v_owner, auth.uid())
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.search_residences(
  double precision, double precision, double precision,
  public.residence_type, numeric, text, text, text, int, int
) from public, anon, authenticated, service_role;

grant execute on function public.search_residences(
  double precision, double precision, double precision,
  public.residence_type, numeric, text, text, text, int, int
) to anon, authenticated, service_role;

revoke execute on function public.get_residence(uuid) from public, anon;
grant execute on function public.get_residence(uuid) to authenticated;

revoke execute on function public.open_conversation(uuid) from public, anon;
grant execute on function public.open_conversation(uuid) to authenticated;


-- Final ACL: moderation is invoked by the authenticated admin console.
grant execute on function public.admin_moderate_residence(uuid, text, text) to authenticated;
