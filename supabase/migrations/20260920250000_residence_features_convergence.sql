-- 20260920250000_residence_features_convergence.sql
-- The production schema already contains these objects, but the active migration
-- lineage did not. Keep fresh environments identical to production.

alter table public.residences
  add column if not exists features jsonb not null default '{}'::jsonb;

create or replace function public.residence_standing(p_features jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_score integer := 0;
  v_known integer := 0;
  v_n integer;
  v_ac text := coalesce(p_features->>'air_conditioning', '');
  v_water text := coalesce(p_features->>'potable_water_available', '');
  v_elec text := coalesce(p_features->>'electricity_available', '');
  v_light text := coalesce(p_features->>'lighting_available', '');
  v_quality text;
begin
  if p_features is null or jsonb_typeof(p_features) <> 'object' then
    return 'non_evalue';
  end if;

  if p_features ? 'air_conditioning' and p_features->'air_conditioning' <> 'null' then v_known := v_known + 1; end if;
  if p_features ? 'rooms_count' and p_features->'rooms_count' <> 'null' then v_known := v_known + 1; end if;
  if p_features ? 'toilets_count' and p_features->'toilets_count' <> 'null' then v_known := v_known + 1; end if;
  if p_features ? 'potable_water_available' and p_features->'potable_water_available' <> 'null' then v_known := v_known + 1; end if;
  if p_features ? 'electricity_available' and p_features->'electricity_available' <> 'null' then v_known := v_known + 1; end if;
  if p_features ? 'lighting_available' and p_features->'lighting_available' <> 'null' then v_known := v_known + 1; end if;

  if v_ac = 'true' then
    v_score := v_score + 2;
    if (p_features->>'air_conditioned_rooms') ~ '^[0-9]+$' then
      v_n := (p_features->>'air_conditioned_rooms')::integer;
      if v_n >= 2 then v_score := v_score + 1; end if;
    end if;
  end if;

  if (p_features->>'rooms_count') ~ '^[0-9]+$' and (p_features->>'rooms_count')::integer >= 4 then
    v_score := v_score + 1;
  end if;

  if (p_features->>'toilets_count') ~ '^[0-9]+$' and (p_features->>'toilets_count')::integer >= 2 then
    v_score := v_score + 1;
  end if;

  if v_water = 'true' then
    v_score := v_score + 2;
    if p_features->>'water_continuity' = 'permanente' then v_score := v_score + 1; end if;
  end if;

  if v_elec = 'true' then
    v_score := v_score + 1;
    v_quality := coalesce(p_features->>'electricity_quality', '');
    if v_quality = 'bon' then v_score := v_score + 1; end if;
    if v_quality = 'tres_bon' then v_score := v_score + 2; end if;
  end if;

  if v_light = 'true' then
    v_score := v_score + 1;
    v_quality := coalesce(p_features->>'lighting_quality', '');
    if v_quality = 'bon' then v_score := v_score + 1; end if;
    if v_quality = 'tres_bon' then v_score := v_score + 2; end if;
  end if;

  if coalesce(p_features->>'backup_power', '') <> '' and p_features->>'backup_power' <> 'aucun' then v_score := v_score + 2; end if;
  if coalesce(p_features->>'fenced', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'gate', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'security_guard', '') = 'true' then v_score := v_score + 2; end if;
  if coalesce(p_features->>'security_cameras', '') = 'true' then v_score := v_score + 2; end if;
  if (p_features->>'parking_spaces') ~ '^[0-9]+$' and (p_features->>'parking_spaces')::integer >= 1 then v_score := v_score + 1; end if;
  if coalesce(p_features->>'garage', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'balcony', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'terrace', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'garden', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'pool', '') = 'true' then v_score := v_score + 3; end if;
  if coalesce(p_features->>'kitchen_equipped', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'water_heater', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'furnished', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'internet_available', '') = 'true' then v_score := v_score + 1; end if;
  if coalesce(p_features->>'fiber_available', '') = 'true' then v_score := v_score + 1; end if;
  if p_features->>'building_condition' = 'bon' then v_score := v_score + 1; end if;
  if p_features->>'building_condition' = 'tres_bon' then v_score := v_score + 2; end if;

  if v_known = 0 then return 'non_evalue'; end if;
  if v_score >= 15 then return 'prestige'; end if;
  if v_score >= 10 then return 'premium'; end if;
  if v_score >= 5 then return 'confort'; end if;
  return 'essentiel';
end;
$$;

revoke execute on function public.residence_standing(jsonb) from public, anon;
grant execute on function public.residence_standing(jsonb) to authenticated;
