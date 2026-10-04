-- KAZA: keep admin unpublish transitions coherent with the
-- residences_moderation_visibility_check invariant.
--
-- Unpublishing an approved residence must also clear verification and return
-- it to the editable draft workflow. This preserves the public visibility
-- invariant instead of producing an impossible approved/unpublished state.

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
    jsonb_build_object('residence_id', p_residence_id)
  );
end;
$function$;

revoke all on function public.admin_unpublish_residence(uuid) from public, anon, authenticated;
grant execute on function public.admin_unpublish_residence(uuid) to authenticated, service_role;
