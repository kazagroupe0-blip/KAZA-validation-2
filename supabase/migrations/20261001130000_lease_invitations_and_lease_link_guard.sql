-- KAZA: targeted landlord -> tenant lease invitation workflow.
-- Additive migration. Only the SHA-256 token hash is stored; no global tenant directory is exposed.

create table if not exists public.lease_invitations (
  id uuid primary key default gen_random_uuid(),
  residence_id uuid not null references public.residences(id) on delete cascade,
  landlord_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'accepted' and accepted_at is not null)
    or
    (status <> 'accepted' and accepted_by is null and accepted_at is null)
  ),
  check (
    (status = 'revoked' and revoked_at is not null)
    or
    status <> 'revoked'
  )
);

create index if not exists lease_invitations_landlord_residence_idx
  on public.lease_invitations (landlord_id, residence_id, status, created_at desc);

create index if not exists lease_invitations_accepted_tenant_idx
  on public.lease_invitations (accepted_by, landlord_id, residence_id, status);

create unique index if not exists lease_invitations_one_pending_per_residence_idx
  on public.lease_invitations (residence_id)
  where status = 'pending';

alter table public.lease_invitations enable row level security;
revoke all on table public.lease_invitations from public, anon, authenticated;
grant all on table public.lease_invitations to service_role;

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

create or replace function public.get_lease_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_inv public.lease_invitations%rowtype;
  v_role public.user_role;
  v_json jsonb;
begin
  select role into v_role
    from public.profiles
   where id = auth.uid();

  if v_role is distinct from 'locataire'::public.user_role then
    raise exception 'Seuls les locataires peuvent consulter une invitation de bail' using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  select *
    into v_inv
    from public.lease_invitations
   where token_hash = encode(sha256(convert_to(lower(p_token), 'UTF8')), 'hex');

  if v_inv.id is null then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  if v_inv.status = 'pending' and v_inv.expires_at <= now() then
    update public.lease_invitations
       set status = 'expired', updated_at = now()
     where id = v_inv.id;
    raise exception 'Invitation expirée' using errcode = 'P0002';
  end if;

  if v_inv.status is distinct from 'pending' then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
           'invitation_id', v_inv.id,
           'expires_at', v_inv.expires_at,
           'residence', jsonb_build_object(
             'id', r.id,
             'title', r.title,
             'city', r.city,
             'zone', r.zone,
             'price_monthly', r.price_monthly,
             'deposit', r.deposit
           ),
           'landlord', jsonb_build_object(
             'full_name', p.full_name
           )
         )
    into v_json
    from public.residences r
    join public.profiles p on p.id = v_inv.landlord_id
   where r.id = v_inv.residence_id;

  if v_json is null then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  return v_json;
end;
$function$;

create or replace function public.accept_lease_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_inv public.lease_invitations%rowtype;
  v_role public.user_role;
  v_res public.residences%rowtype;
  v_residence_id uuid;
begin
  select role into v_role
    from public.profiles
   where id = auth.uid();

  if v_role is distinct from 'locataire'::public.user_role then
    raise exception 'Seuls les locataires peuvent accepter une invitation de bail' using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  select residence_id into v_residence_id
    from public.lease_invitations
   where token_hash = encode(sha256(convert_to(lower(p_token), 'UTF8')), 'hex');

  if v_residence_id is null then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  -- Lock the residence first. This serializes concurrent acceptance attempts for a property.
  select *
    into v_res
    from public.residences
   where id = v_residence_id
   for update;

  if v_res.id is null then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  select *
    into v_inv
    from public.lease_invitations
   where token_hash = encode(sha256(convert_to(lower(p_token), 'UTF8')), 'hex')
     and residence_id = v_res.id
   for update;

  if v_inv.id is null then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  if v_inv.status = 'pending' and v_inv.expires_at <= now() then
    update public.lease_invitations
       set status = 'expired', updated_at = now()
     where id = v_inv.id;
    raise exception 'Invitation expirée' using errcode = 'P0002';
  end if;

  if v_inv.status is distinct from 'pending' then
    raise exception 'Invitation invalide ou déjà utilisée' using errcode = 'P0002';
  end if;

  if v_res.owner_id <> v_inv.landlord_id then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  if auth.uid() = v_inv.landlord_id then
    raise exception 'Le bailleur ne peut pas accepter sa propre invitation' using errcode = '42501';
  end if;

  if v_res.status = 'occupee'
     or exists (
       select 1
         from public.leases
        where residence_id = v_res.id
          and status = 'active'
     ) then
    raise exception 'Ce bien est déjà occupé' using errcode = 'P0001';
  end if;

  update public.lease_invitations
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now(),
         updated_at = now()
   where id = v_inv.id
   returning * into v_inv;

  update public.lease_invitations
     set status = 'revoked',
         revoked_at = now(),
         updated_at = now()
   where residence_id = v_inv.residence_id
     and landlord_id = v_inv.landlord_id
     and id <> v_inv.id
     and status = 'pending';

  insert into public.notifications (
    user_id, type, title, body, data
  )
  values (
    v_inv.landlord_id,
    'lease',
    'Invitation acceptée',
    concat('Le locataire a accepté votre invitation pour « ', v_res.title, ' ».'),
    jsonb_build_object(
      'kind', 'lease_invitation_accepted',
      'invitation_id', v_inv.id,
      'residence_id', v_res.id,
      'href', concat('/landlord/residences/', v_res.id, '/edit')
    )
  );

  return jsonb_build_object(
    'invitation_id', v_inv.id,
    'residence_id', v_inv.residence_id,
    'accepted_at', v_inv.accepted_at
  );
end;
$function$;

create or replace function public.revoke_lease_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.lease_invitations%rowtype;
begin
  select *
    into v_row
    from public.lease_invitations
   where id = p_invitation_id
     and landlord_id = auth.uid()
   for update;

  if v_row.id is null then
    raise exception 'Invitation introuvable' using errcode = 'P0002';
  end if;

  if v_row.status is distinct from 'pending' then
    raise exception 'Invitation non active' using errcode = 'P0001';
  end if;

  update public.lease_invitations
     set status = 'revoked',
         revoked_at = now(),
         updated_at = now()
   where id = v_row.id;
end;
$function$;

create or replace function public.list_my_lease_invitations(p_residence_id uuid default null)
returns jsonb
language plpgsql
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

  if v_role is distinct from 'bailleur'::public.user_role then
    raise exception 'Réservé aux bailleurs' using errcode = '42501';
  end if;

  update public.lease_invitations
     set status = 'expired', updated_at = now()
   where landlord_id = auth.uid()
     and status = 'pending'
     and expires_at <= now()
     and (p_residence_id is null or residence_id = p_residence_id);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'invitation_id', i.id,
        'residence_id', i.residence_id,
        'status', i.status,
        'expires_at', i.expires_at,
        'accepted_by', i.accepted_by,
        'accepted_at', i.accepted_at,
        'created_at', i.created_at
      )
      order by i.created_at desc
    ),
    '[]'::jsonb
  )
    into v_json
    from public.lease_invitations i
   where i.landlord_id = auth.uid()
     and (p_residence_id is null or i.residence_id = p_residence_id);

  return v_json;
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
            and i.status = 'accepted'
       )
     );

  return coalesce(v_json, '[]'::jsonb);
end;
$function$;

revoke all on function public.create_lease_invitation(uuid) from public, anon, authenticated;
grant execute on function public.create_lease_invitation(uuid) to authenticated, service_role;

revoke all on function public.get_lease_invitation(text) from public, anon, authenticated;
grant execute on function public.get_lease_invitation(text) to authenticated, service_role;

revoke all on function public.accept_lease_invitation(text) from public, anon, authenticated;
grant execute on function public.accept_lease_invitation(text) to authenticated, service_role;

revoke all on function public.revoke_lease_invitation(uuid) from public, anon, authenticated;
grant execute on function public.revoke_lease_invitation(uuid) to authenticated, service_role;

revoke all on function public.list_my_lease_invitations(uuid) from public, anon, authenticated;
grant execute on function public.list_my_lease_invitations(uuid) to authenticated, service_role;

revoke all on function public.create_lease(uuid, uuid, date, numeric, numeric, date) from public, anon, authenticated;
grant execute on function public.create_lease(uuid, uuid, date, numeric, numeric, date) to authenticated, service_role;

revoke all on function public.list_tenants() from public, anon;
grant execute on function public.list_tenants() to authenticated, service_role;
