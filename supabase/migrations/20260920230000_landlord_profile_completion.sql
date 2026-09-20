-- ============================================================
-- Landlord profile completion
-- - Persists notification resolution for actionable in-app notices.
-- - Keeps profiles.onboarding_completed synchronized with the actual
--   minimum landlord profile fields required by KAZA.
-- - Creates one idempotent "profile incomplete" notification.
-- ============================================================

alter table public.notifications
  add column if not exists resolved_at timestamptz;

create index if not exists notifications_user_resolved_idx
  on public.notifications (user_id, resolved_at, created_at desc);

comment on column public.notifications.resolved_at is
  'Notification resolved by the business workflow; resolved notifications are hidden from actionable lists.';

create or replace function public.profiles_guard_onboarding_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complete boolean;
begin
  -- Internal SQL/migration/service-role calls are allowed to maintain the
  -- persisted flag. Authenticated clients may only submit the truthful
  -- value derived from the profile fields.
  if auth.role() = 'service_role' or auth.role() is null then
    return new;
  end if;

  v_complete :=
    new.role = 'bailleur'
    and nullif(trim(coalesce(new.full_name, '')), '') is not null
    and new.phone is not null
    and new.phone ~ '^\+229[0-9]{10}$'
    and nullif(trim(coalesce(new.email, '')), '') is not null
    and nullif(trim(coalesce(new.business_name, '')), '') is not null
    and new.momo_provider in ('mtn', 'moov', 'celtiis')
    and new.momo_number is not null
    and new.momo_number ~ '^\+229[0-9]{10}$';

  if new.onboarding_completed is distinct from v_complete then
    raise exception 'Le statut de complétude du profil est calculé automatiquement'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
drop trigger if exists profiles_before_update_onboarding_state on public.profiles;
create trigger profiles_before_update_onboarding_state
before update of onboarding_completed on public.profiles
for each row
execute function public.profiles_guard_onboarding_state();

create or replace function public.sync_landlord_profile_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complete boolean;
  v_missing text[] := '{}';
begin
  if new.role <> 'bailleur' then
    return new;
  end if;

  if nullif(trim(coalesce(new.full_name, '')), '') is null then
    v_missing := array_append(v_missing, 'Nom complet');
  end if;

  if new.phone is null or new.phone !~ '^\+229[0-9]{10}$' then
    v_missing := array_append(v_missing, 'Téléphone');
  end if;

  if nullif(trim(coalesce(new.email, '')), '') is null then
    v_missing := array_append(v_missing, 'Email');
  end if;

  if nullif(trim(coalesce(new.business_name, '')), '') is null then
    v_missing := array_append(v_missing, 'Nom ou raison sociale');
  end if;

  if new.momo_provider is null or new.momo_provider not in ('mtn', 'moov', 'celtiis') then
    v_missing := array_append(v_missing, 'Opérateur Mobile Money');
  end if;

  if new.momo_number is null or new.momo_number !~ '^\+229[0-9]{10}$' then
    v_missing := array_append(v_missing, 'Numéro Mobile Money');
  end if;

  v_complete := coalesce(array_length(v_missing, 1), 0) = 0;

  -- The nested update is the authoritative computed state. The guard above
  -- verifies any explicit client value against the same business rule.
  if new.onboarding_completed is distinct from v_complete then
    update public.profiles
       set onboarding_completed = v_complete
     where id = new.id;
  end if;

  if v_complete then
    update public.notifications
       set resolved_at = coalesce(resolved_at, now()),
           read_at = coalesce(read_at, now())
     where user_id = new.id
       and type = 'system'
       and data->>'kind' = 'landlord_profile_incomplete'
       and resolved_at is null;
  else
    if not exists (
      select 1
        from public.notifications n
       where n.user_id = new.id
         and n.type = 'system'
         and n.data->>'kind' = 'landlord_profile_incomplete'
         and n.resolved_at is null
    ) then
      insert into public.notifications (user_id, type, title, body, data)
      values (
        new.id,
        'system',
        'Profil propriétaire incomplet',
        'Complétez votre profil pour utiliser pleinement KAZA et configurer la réception de vos loyers.',
        jsonb_build_object(
          'kind', 'landlord_profile_incomplete',
          'href', '/profile',
          'missing_fields', to_jsonb(v_missing)
        )
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_landlord_completion on public.profiles;
create trigger profiles_landlord_completion
after insert or update of full_name, email, phone, business_name, tax_id,
  momo_provider, momo_number, bank_name, bank_iban, consent_apdp, role
on public.profiles
for each row
execute function public.sync_landlord_profile_completion();

-- Backfill the persisted completion flag and one actionable notification
-- for existing landlord accounts.
do $$
declare
  p record;
  v_missing text[];
  v_complete boolean;
begin
  for p in
    select *
      from public.profiles
     where role = 'bailleur'
  loop
    v_missing := '{}';

    if nullif(trim(coalesce(p.full_name, '')), '') is null then
      v_missing := array_append(v_missing, 'Nom complet');
    end if;
    if p.phone is null or p.phone !~ '^\+229[0-9]{10}$' then
      v_missing := array_append(v_missing, 'Téléphone');
    end if;
    if nullif(trim(coalesce(p.email, '')), '') is null then
      v_missing := array_append(v_missing, 'Email');
    end if;
    if nullif(trim(coalesce(p.business_name, '')), '') is null then
      v_missing := array_append(v_missing, 'Nom ou raison sociale');
    end if;
    if p.momo_provider is null or p.momo_provider not in ('mtn', 'moov', 'celtiis') then
      v_missing := array_append(v_missing, 'Opérateur Mobile Money');
    end if;
    if p.momo_number is null or p.momo_number !~ '^\+229[0-9]{10}$' then
      v_missing := array_append(v_missing, 'Numéro Mobile Money');
    end if;

    v_complete := coalesce(array_length(v_missing, 1), 0) = 0;

    update public.profiles
       set onboarding_completed = v_complete
     where id = p.id;

    if v_complete then
      update public.notifications
         set resolved_at = coalesce(resolved_at, now()),
             read_at = coalesce(read_at, now())
       where user_id = p.id
         and type = 'system'
         and data->>'kind' = 'landlord_profile_incomplete'
         and resolved_at is null;
    elsif not exists (
      select 1 from public.notifications n
       where n.user_id = p.id
         and n.type = 'system'
         and n.data->>'kind' = 'landlord_profile_incomplete'
         and n.resolved_at is null
    ) then
      insert into public.notifications (user_id, type, title, body, data)
      values (
        p.id,
        'system',
        'Profil propriétaire incomplet',
        'Complétez votre profil pour utiliser pleinement KAZA et configurer la réception de vos loyers.',
        jsonb_build_object(
          'kind', 'landlord_profile_incomplete',
          'href', '/profile',
          'missing_fields', to_jsonb(v_missing)
        )
      );
    end if;
  end loop;
end;
$$;
