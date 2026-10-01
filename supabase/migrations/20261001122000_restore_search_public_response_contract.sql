-- Restore the existing public search response contract while keeping
-- the newly validated input bounds from 20261001114000.
-- The public search API historically returns owner_id/full_name and landlord badges.

create or replace function public.search_residences(
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_km double precision default 10,
  p_type public.residence_type default null,
  p_max_price numeric default null,
  p_q text default null,
  p_city text default null,
  p_zone text default null,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table(
  id uuid,
  title text,
  description text,
  type public.residence_type,
  price_monthly numeric,
  deposit numeric,
  bedrooms integer,
  bathrooms integer,
  surface numeric,
  city text,
  zone text,
  address text,
  lat double precision,
  lng double precision,
  photos text[],
  status public.residence_status,
  distance_km double precision,
  owner_id uuid,
  owner_full_name text,
  owner_is_verified_landlord boolean,
  owner_is_premium boolean,
  features jsonb,
  standing_level text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_point geometry := null;
  v_radius_km double precision := least(greatest(coalesce(p_radius_km,10),0),100);
  v_limit integer := least(greatest(coalesce(p_limit,40),1),40);
  v_offset integer := least(greatest(coalesce(p_offset,0),0),10000);
begin
  if (p_lat is null)<>(p_lng is null) then
    raise exception 'Latitude et longitude doivent être fournies ensemble' using errcode='22023';
  end if;

  if p_lat is not null and (p_lat<>p_lat or p_lat<-90 or p_lat>90) then
    raise exception 'Latitude invalide' using errcode='22023';
  end if;

  if p_lng is not null and (p_lng<>p_lng or p_lng<-180 or p_lng>180) then
    raise exception 'Longitude invalide' using errcode='22023';
  end if;

  if p_radius_km<>p_radius_km then
    raise exception 'Rayon invalide' using errcode='22023';
  end if;

  if length(coalesce(p_q,''))>200 then
    raise exception 'Recherche trop longue' using errcode='22023';
  end if;

  if length(coalesce(p_city,''))>100 then
    raise exception 'Ville trop longue' using errcode='22023';
  end if;

  if length(coalesce(p_zone,''))>100 then
    raise exception 'Zone trop longue' using errcode='22023';
  end if;

  if p_lat is not null and p_lng is not null then
    v_point:=st_setsrid(st_makepoint(p_lng,p_lat),4326);
  end if;

  return query
  select
    r.id,
    r.title,
    r.description,
    r.type,
    r.price_monthly,
    r.deposit,
    r.bedrooms,
    r.bathrooms,
    r.surface,
    r.city,
    r.zone,
    r.address,
    r.lat,
    r.lng,
    r.photos,
    r.status,
    case
      when v_point is not null and r.geom is not null
        then st_distance(r.geom::geography,v_point::geography)/1000.0
      else null
    end,
    r.owner_id,
    p.full_name,
    p.is_verified_landlord,
    p.is_premium,
    r.features,
    public.residence_standing(r.features)
  from public.residences r
  left join public.profiles p on p.id=r.owner_id
  where r.is_published=true
    and r.is_verified=true
    and r.moderation_status='approved'
    and r.status='libre'
    and (p_type is null or r.type=p_type)
    and (p_max_price is null or r.price_monthly<=p_max_price)
    and (p_city is null or r.city ilike p_city)
    and (p_zone is null or r.zone ilike p_zone)
    and (p_q is null or r.title ilike '%'||p_q||'%' or r.description ilike '%'||p_q||'%')
    and (
      v_point is null
      or r.geom is null
      or st_dwithin(r.geom::geography,v_point::geography,v_radius_km*1000)
    )
  order by
    case when v_point is not null and r.geom is not null
      then r.geom <-> v_point else null end asc nulls last,
    r.created_at desc
  limit v_limit offset v_offset;
end
$function$;
