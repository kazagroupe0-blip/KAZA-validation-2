-- 20260921010000_residence_moderation_revalidation.sql
-- Any substantive landlord edit to an approved residence invalidates
-- the previous moderation decision and hides the listing until resubmission.

create or replace function public.residences_guard_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role'
     or auth.role() is null
     or public.is_admin()
     or current_setting('kaza.internal_residence_transition', true) = '1' then
    return new;
  end if;

  -- Never let a client change ownership or moderation/publication state directly.
  new.is_verified := old.is_verified;
  new.is_published := old.is_published;
  new.owner_id := old.owner_id;
  new.moderation_status := old.moderation_status;
  new.moderation_reason := old.moderation_reason;
  new.moderated_at := old.moderated_at;

  -- Once an approved listing's public-facing content changes, the previous
  -- moderation decision is no longer valid. The landlord must resubmit it.
  if old.moderation_status = 'approved'
     and (
       new.title is distinct from old.title
       or new.description is distinct from old.description
       or new.type is distinct from old.type
       or new.price_monthly is distinct from old.price_monthly
       or new.deposit is distinct from old.deposit
       or new.bedrooms is distinct from old.bedrooms
       or new.bathrooms is distinct from old.bathrooms
       or new.surface is distinct from old.surface
       or new.address is distinct from old.address
       or new.city is distinct from old.city
       or new.zone is distinct from old.zone
       or new.lat is distinct from old.lat
       or new.lng is distinct from old.lng
       or new.geom is distinct from old.geom
       or new.photos is distinct from old.photos
       or new.features is distinct from old.features
     ) then
    new.is_published := false;
    new.is_verified := false;
    new.moderation_status := 'draft';
    new.moderation_reason := null;
    new.moderated_at := null;
  end if;

  return new;
end;
$$;
