-- KAZA: allow the landlord to cancel an accepted invitation before lease creation.
-- Consumed invitations (already used by create_lease) remain immutable.

create or replace function public.revoke_lease_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.lease_invitations%rowtype;
  v_title text;
  v_tenant_id uuid;
begin
  if (select role from public.profiles where id = auth.uid()) is distinct from 'bailleur'::public.user_role then
    raise exception 'Réservé aux bailleurs' using errcode = '42501';
  end if;

  select *
    into v_row
    from public.lease_invitations
   where id = p_invitation_id
     and landlord_id = auth.uid()
   for update;

  if v_row.id is null then
    raise exception 'Invitation introuvable' using errcode = 'P0002';
  end if;

  if v_row.status not in ('pending', 'accepted') then
    raise exception 'Invitation non active' using errcode = 'P0001';
  end if;

  if v_row.status = 'accepted' then
    select title into v_title
      from public.residences
     where id = v_row.residence_id;

    v_tenant_id := v_row.accepted_by;
  end if;

  update public.lease_invitations
     set status = 'revoked',
         revoked_at = now(),
         accepted_by = null,
         accepted_at = null,
         updated_at = now()
   where id = v_row.id;

  if v_tenant_id is not null then
    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_tenant_id,
      'lease',
      'Invitation annulée',
      concat(
        'Le bailleur a annulé votre invitation pour « ',
        coalesce(v_title, 'ce logement'),
        ' ».'
      ),
      jsonb_build_object(
        'kind', 'lease_invitation_revoked',
        'invitation_id', v_row.id,
        'residence_id', v_row.residence_id
      )
    );
  end if;
end;
$function$;

revoke all on function public.revoke_lease_invitation(uuid) from public, anon, authenticated;
grant execute on function public.revoke_lease_invitation(uuid) to authenticated, service_role;
