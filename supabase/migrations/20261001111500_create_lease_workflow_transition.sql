-- Functional follow-up: allow the validated lease workflow to update availability.
--
-- residences_guard_owner intentionally rejects direct client status changes.
-- create_lease performs all authorization/validation checks first, then marks
-- its single internal status transition explicitly.

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
   where id = p_residence_id;

  if v_res is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if v_res.owner_id <> auth.uid() then
    raise exception 'Vous ne gérez pas ce bien' using errcode = '42501';
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

  select role
    into v_tenant_role
    from public.profiles
   where id = p_tenant_id;

  if v_tenant_role is distinct from 'locataire'::public.user_role then
    raise exception 'Le bénéficiaire du bail doit avoir le rôle locataire'
      using errcode = '42501';
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

  insert into public.notifications (user_id, type, title, body, data)
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
