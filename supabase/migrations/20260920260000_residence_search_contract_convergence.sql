-- 20260920260000_residence_search_contract_convergence.sql
-- Converge the fresh migration lineage with the production search_residences contract.
-- Production already exposes features + computed standing_level in this RPC.
-- standing_level is NOT a residences column.

alter table public.residences
  add column if not exists features jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.residences'::regclass
      and conname = 'residences_features_object_chk'
  ) then
    alter table public.residences
      add constraint residences_features_object_chk
      check (jsonb_typeof(features) = 'object');
  end if;
end;
$$;

drop function if exists public.search_residences(
  double precision, double precision, double precision,
  public.residence_type, numeric, text, text, text, int, int
);

create function public.search_residences(
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

revoke execute on function public.search_residences(
  double precision, double precision, double precision,
  public.residence_type, numeric, text, text, text, int, int
) from public, anon, authenticated, service_role;

grant execute on function public.search_residences(
  double precision, double precision, double precision,
  public.residence_type, numeric, text, text, text, int, int
) to anon, authenticated, service_role;
