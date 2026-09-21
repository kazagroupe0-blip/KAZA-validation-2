-- Pending moderation is not public and must not consume the free publication quota.
create or replace function public.submit_residence_for_review(p_residence_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.residences%rowtype;
begin
  select * into v_row
  from public.residences
  where id = p_residence_id
    and owner_id = auth.uid();

  if v_row.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if v_row.moderation_status not in ('draft','rejected') then
    raise exception 'Cette annonce ne peut pas être soumise dans son état actuel' using errcode = 'P0001';
  end if;

  if nullif(trim(v_row.title), '') is null
     or nullif(trim(v_row.city), '') is null
     or nullif(trim(v_row.zone), '') is null
     or v_row.price_monthly <= 0
     or coalesce(array_length(v_row.photos, 1), 0) = 0 then
    raise exception 'Annonce incomplète : titre, ville, zone, loyer et au moins une photo sont requis'
      using errcode = '22023';
  end if;

  -- A pending listing is awaiting review and therefore must not be public.
  -- Publication is granted only by admin_moderate_residence(approve).
  perform set_config('kaza.internal_residence_transition', '1', true);

  update public.residences
     set is_published = false,
         is_verified = false,
         moderation_status = 'pending',
         moderation_reason = null,
         moderated_at = null,
         updated_at = now()
   where id = p_residence_id;
end;
$$;

revoke execute on function public.submit_residence_for_review(uuid) from public, anon;
grant execute on function public.submit_residence_for_review(uuid) to authenticated;
