-- KAZA: close integration-test-discovered workflow gaps without weakening RLS.
-- 1) Visits proposals must go through propose_visit() SECURITY DEFINER.
-- 2) Admin unpublish must leave moderation/publication state coherent.

drop policy if exists visits_insert_tenant on public.visits;

create or replace function public.admin_unpublish_residence(p_residence_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_status public.residence_status;
  v_owner_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Seul un administrateur peut dépublier une résidence'
      using errcode = '42501';
  end if;

  select status, owner_id
    into v_status, v_owner_id
    from public.residences
   where id = p_residence_id;

  if v_owner_id is null then
    raise exception 'Résidence introuvable' using errcode = 'P0002';
  end if;

  if v_status = 'occupee' then
    raise exception 'Impossible de dépublier une résidence occupée'
      using errcode = 'P0001';
  end if;

  perform set_config('kaza.internal_residence_transition', '1', true);

  update public.residences
     set is_published = false,
         is_verified = false,
         moderation_status = 'draft',
         moderation_reason = null,
         moderated_at = null,
         updated_at = now()
   where id = p_residence_id;

  if not found then
    raise exception 'Résidence introuvable' using errcode = 'P0002';
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_owner_id,
    'system',
    'Résidence dépubliée',
    'Votre annonce a été retirée de la publication par l''administration.',
    jsonb_build_object(
      'residence_id', p_residence_id,
      'moderation_status', 'draft'
    )
  );
end;
$function$;

revoke execute on function public.admin_unpublish_residence(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_unpublish_residence(uuid)
  to authenticated;
