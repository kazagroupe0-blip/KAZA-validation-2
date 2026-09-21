-- 20260921022000_fix_landlord_profile_completion.sql
-- Make onboarding state deterministic and atomic with profile writes.
-- The previous implementation computed the flag in an AFTER trigger and
-- issued a nested UPDATE. This migration computes it in the same row write.

create or replace function public.sync_landlord_profile_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complete boolean;
begin
  if new.role <> 'bailleur' then
    new.onboarding_completed := false;
    return new;
  end if;

  v_complete :=
    nullif(trim(coalesce(new.full_name, '')), '') is not null
    and new.phone is not null
    and new.phone ~ '^\+229[0-9]{10}$'
    and nullif(trim(coalesce(new.email, '')), '') is not null
    and nullif(trim(coalesce(new.business_name, '')), '') is not null
    and new.momo_provider in ('mtn', 'moov', 'celtiis')
    and new.momo_number is not null
    and new.momo_number ~ '^\+229[0-9]{10}$';

  new.onboarding_completed := v_complete;
  return new;
end;
$$;

drop trigger if exists profiles_landlord_completion on public.profiles;
create trigger profiles_landlord_completion
before insert or update of full_name, email, phone, business_name, tax_id,
  momo_provider, momo_number, bank_name, bank_iban, consent_apdp, role
on public.profiles
for each row
execute function public.sync_landlord_profile_completion();

create or replace function public.resolve_landlord_profile_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
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

  if new.onboarding_completed then
    update public.notifications
       set resolved_at = coalesce(resolved_at, now()),
           read_at = coalesce(read_at, now())
     where user_id = new.id
       and type = 'system'
       and data->>'kind' = 'landlord_profile_incomplete'
       and resolved_at is null;
  else
    if not exists (
      select 1 from public.notifications n
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

drop trigger if exists profiles_landlord_notification on public.profiles;
create trigger profiles_landlord_notification
after insert or update of onboarding_completed, full_name, email, phone,
  business_name, tax_id, momo_provider, momo_number, bank_name, bank_iban,
  consent_apdp, role
on public.profiles
for each row
execute function public.resolve_landlord_profile_notification();

update public.profiles
set onboarding_completed =
  role = 'bailleur'
  and nullif(trim(coalesce(full_name, '')), '') is not null
  and phone is not null
  and phone ~ '^\+229[0-9]{10}$'
  and nullif(trim(coalesce(email, '')), '') is not null
  and nullif(trim(coalesce(business_name, '')), '') is not null
  and momo_provider in ('mtn', 'moov', 'celtiis')
  and momo_number is not null
  and momo_number ~ '^\+229[0-9]{10}$'
where role = 'bailleur';
