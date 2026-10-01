-- KAZA: close the lease-invitation lifecycle after tenant acceptance.
-- Additive follow-up to 20261001130000_lease_invitations_and_lease_link_guard.sql.
-- A residence can have at most one pending/accepted invitation at a time.
-- Once a lease is created from an accepted invitation, the invitation is consumed
-- and can no longer authorize another lease.

alter table public.lease_invitations
  drop constraint if exists lease_invitations_status_check;

alter table public.lease_invitations
  add constraint lease_invitations_status_check
  check (status in ('pending', 'accepted', 'consumed', 'revoked', 'expired'));

alter table public.lease_invitations
  drop constraint if exists lease_invitations_accepted_state_check;

alter table public.lease_invitations
  add constraint lease_invitations_accepted_state_check
  check (
    (
      status in ('accepted', 'consumed')
      and accepted_by is not null
      and accepted_at is not null
    )
    or
    (
      status not in ('accepted', 'consumed')
      and accepted_by is null
      and accepted_at is null
    )
  );

drop index if exists public.lease_invitations_one_pending_per_residence_idx;

create unique index lease_invitations_one_current_per_residence_idx
  on public.lease_invitations (residence_id)
  where status in ('pending', 'accepted');

create or replace function public.create_lease_invitation(p_residence_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_res public.residences%rowtype;
  v_token text;
  v_invitation_id uuid;
  v_expires_at timestamptz;
  v_current_status text;
begin
  if (select role from public.profiles where id = auth.uid()) is distinct from 'bailleur'::public.user_role then
    raise exception 'Réservé aux bailleurs' using errcode = '42501';
  end if;

  select *
    into v_res
    from public.residences
   where id = p_residence_id
     and owner_id = auth.uid()
   for update;

  if v_res.id is null then
    raise exception 'Bien introuvable ou non géré par ce compte' using errcode = 'P0002';
  end if;

  if v_res.status = 'occupee'
     or exists (
       select 1
         from public.leases
        where residence_id = p_residence_id
          and status = 'active'
     ) then
    raise exception 'Ce bien est déjà occupé' using errcode = 'P0001';
  end if;

  select i.status
    into v_current_status
    from public.lease_invitations i
   where i.residence_id = p_residence_id
     and i.landlord_id = auth.uid()
     and i.status in ('pending', 'accepted')
   limit 1
   for update;

  if v_current_status = 'accepted' then
    raise exception 'Une invitation a déjà été acceptée pour ce bien. Créez d''abord le bail.' using errcode = 'P0001';
  end if;

  update public.lease_invitations
     set status = 'revoked',
         revoked_at = now(),
         updated_at = now()
   where residence_id = p_residence_id
     and landlord_id = auth.uid()
     and status = 'pending';

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires_at := now() + interval '48 hours';

  insert into public.lease_invitations (
    residence_id, landlord_id, token_hash, expires_at
  )
  values (
    p_residence_id,
    auth.uid(),
    encode(sha256(convert_to(lower(v_token), 'UTF8')), 'hex'),
    v_expires_at
  )
  returning id into v_invitation_id;

  return jsonb_build_object(
    'invitation_id', v_invitation_id,
    'token', v_token,
    'expires_at', v_expires_at
  );
end;
$function$;

create or replace function public.create_lease(
  p_residence_id uuid,
  p_tenant_id uuid,
  p_start_date date,
  p_monthly_rent numeric,
  p_deposit numeric default 0,
  p_end_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_res public.residences%rowtype;
  v_id uuid;
  v_tenant_role public.user_role;
begin
  select * into v_res
    from public.residences
   where id = p_residence_id
   for update;

  if v_res.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;
  if v_res.owner_id <> auth.uid() then
    raise exception 'Vous ne gérez pas ce bien' using errcode = '42501';
  end if;
  if p_tenant_id = auth.uid() then
    raise exception 'Vous ne pouvez pas créer un bail à votre propre nom' using errcode = '42501';
  end if;
  if v_res.status = 'occupee' then
    raise exception 'Ce bien est déjà occupé' using errcode = 'P0001';
  end if;
  if p_deposit > p_monthly_rent * 3 then
    raise exception 'Caution supérieure à 3 mois de loyer (Loi 2022-30)' using errcode = 'P0001';
  end if;
  if p_monthly_rent <= 0 then
    raise exception 'Le loyer mensuel doit être strictement positif' using errcode = 'P0001';
  end if;
  if p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'La date de fin doit être postérieure à la date de début' using errcode = 'P0001';
  end if;

  select role into v_tenant_role
    from public.profiles
   where id = p_tenant_id;

  if v_tenant_role is distinct from 'locataire'::public.user_role then
    raise exception 'Le bénéficiaire du bail doit avoir le rôle locataire' using errcode = '42501';
  end if;

  if not exists (
       select 1
         from public.leases l
        where l.residence_id = p_residence_id
          and l.landlord_id = auth.uid()
          and l.tenant_id = p_tenant_id
     )
     and not exists (
       select 1
         from public.conversations c
        where c.residence_id = p_residence_id
          and c.landlord_id = auth.uid()
          and c.tenant_id = p_tenant_id
     )
     and not exists (
       select 1
         from public.lease_invitations i
        where i.residence_id = p_residence_id
          and i.landlord_id = auth.uid()
          and i.accepted_by = p_tenant_id
          and i.status = 'accepted'
     )
  then
    raise exception 'Le locataire doit d''abord être rattaché à ce bien par une conversation ou une invitation acceptée' using errcode = '42501';
  end if;

  insert into public.leases (
    residence_id,
    tenant_id,
    landlord_id,
    monthly_rent,
    deposit,
    start_date,
    end_date,
    date_fn_couverture
  )
  values (
    p_residence_id,
    p_tenant_id,
    auth.uid(),
    p_monthly_rent,
    p_deposit,
    p_start_date,
    p_end_date,
    p_start_date
  )
  returning id into v_id;

  update public.lease_invitations
     set status = 'consumed',
         updated_at = now()
   where residence_id = p_residence_id
     and landlord_id = auth.uid()
     and accepted_by = p_tenant_id
     and status = 'accepted';

  perform set_config('kaza.internal_residence_transition', '1', true);

  update public.residences
     set status = 'occupee'
   where id = p_residence_id;

  insert into public.notifications (
    user_id, type, title, body, data
  )
  values (
    p_tenant_id,
    'lease',
    'Bail créé',
    concat('Votre bail pour « ', v_res.title, ' » a été créé — bienvenue chez vous.'),
    jsonb_build_object('lease_id', v_id)
  );

  return v_id;
end;
$function$;

create or replace function public.list_tenants()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_role public.user_role;
  v_json jsonb;
begin
  select role into v_role
    from public.profiles
   where id = auth.uid();

  if v_role not in ('bailleur', 'admin') then
    raise exception 'Réservé aux bailleurs' using errcode = '42501';
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'id', p.id,
             'full_name', p.full_name,
             'email', p.email,
             'phone', p.phone
           )
           order by p.full_name
         )
    into v_json
    from public.profiles p
   where p.role = 'locataire'
     and (
       exists (
         select 1
           from public.leases l
          where l.tenant_id = p.id
            and l.landlord_id = auth.uid()
       )
       or exists (
         select 1
           from public.conversations c
          where c.tenant_id = p.id
            and c.landlord_id = auth.uid()
       )
       or exists (
         select 1
           from public.lease_invitations i
          where i.accepted_by = p.id
            and i.landlord_id = auth.uid()
            and i.status in ('accepted', 'consumed')
       )
     );

  return coalesce(v_json, '[]'::jsonb);
end;
$function$;

revoke all on function public.create_lease_invitation(uuid) from public, anon, authenticated;
grant execute on function public.create_lease_invitation(uuid) to authenticated, service_role;

revoke all on function public.create_lease(uuid, uuid, date, numeric, numeric, date) from public, anon, authenticated;
grant execute on function public.create_lease(uuid, uuid, date, numeric, numeric, date) to authenticated, service_role;

revoke all on function public.list_tenants() from public, anon;
grant execute on function public.list_tenants() to authenticated, service_role;
