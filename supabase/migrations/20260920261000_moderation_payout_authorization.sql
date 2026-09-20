-- 20260920261000_moderation_payout_authorization.sql
-- Harden trusted internal state transitions without reintroducing the
-- SECURITY DEFINER current_user='postgres' bypass.

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

  new.is_verified := old.is_verified;
  new.is_published := old.is_published;
  new.owner_id := old.owner_id;
  new.moderation_status := old.moderation_status;
  new.moderation_reason := old.moderation_reason;
  new.moderated_at := old.moderated_at;
  return new;
end;
$$;

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

  perform set_config('kaza.internal_residence_transition', '1', true);

  update public.residences
     set is_published = true,
         is_verified = false,
         moderation_status = 'pending',
         moderation_reason = null,
         moderated_at = null,
         updated_at = now()
   where id = p_residence_id;
end;
$$;

create or replace function public.withdraw_residence_publication(p_residence_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('kaza.internal_residence_transition', '1', true);

  update public.residences
     set is_published = false,
         moderation_status = case
           when moderation_status in ('pending','approved') then 'draft'
           else moderation_status
         end,
         updated_at = now()
   where id = p_residence_id
     and owner_id = auth.uid()
     and moderation_status in ('pending','approved');

  if not found then
    raise exception 'Bien introuvable ou déjà retiré' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.admin_moderate_residence(
  p_residence_id uuid,
  p_action text,
  p_reason text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.residences%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_admin() then
    raise exception 'Accès réservé à l''administration' using errcode = '42501';
  end if;

  if p_action not in ('approve', 'reject') then
    raise exception 'Action invalide' using errcode = '22023';
  end if;

  select * into v_row
  from public.residences
  where id = p_residence_id;

  if v_row.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if v_row.moderation_status <> 'pending' then
    raise exception 'Cette annonce n''est pas en attente de modération' using errcode = 'P0001';
  end if;

  if p_action = 'reject' and v_reason is null then
    raise exception 'Un motif est obligatoire pour un refus' using errcode = '22023';
  end if;

  perform set_config('kaza.internal_residence_transition', '1', true);

  if p_action = 'approve' then
    update public.residences
       set is_verified = true,
           is_published = true,
           moderation_status = 'approved',
           moderation_reason = null,
           moderated_at = now(),
           updated_at = now()
     where id = p_residence_id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_row.owner_id,
      'system',
      'Bien vérifié',
      'Votre bien « ' || v_row.title || ' » a été approuvé et est maintenant visible dans la recherche.',
      jsonb_build_object('residence_id', p_residence_id, 'moderation_status', 'approved')
    );
  else
    update public.residences
       set is_verified = false,
           is_published = false,
           moderation_status = 'rejected',
           moderation_reason = v_reason,
           moderated_at = now(),
           updated_at = now()
     where id = p_residence_id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_row.owner_id,
      'system',
      'Annonce refusée',
      'Votre bien « ' || v_row.title || ' » nécessite des corrections. Motif : ' || v_reason,
      jsonb_build_object(
        'residence_id', p_residence_id,
        'moderation_status', 'rejected',
        'reason', v_reason
      )
    );
  end if;
end;
$$;

create or replace function public.admin_retry_landlord_payout(
  p_payout_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_admin() then
    raise exception 'Accès réservé à l’administration' using errcode = '42501';
  end if;

  update public.landlord_payouts
     set status = 'queued',
         next_attempt_at = now(),
         failed_at = null,
         last_error = null
   where id = p_payout_id
     and status in ('failed', 'manual_review');

  if not found then
    raise exception 'Reversement introuvable ou non relançable' using errcode = 'P0002';
  end if;
end;
$$;
