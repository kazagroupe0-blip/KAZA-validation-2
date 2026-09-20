-- 20260920210000_moderation_workflow.sql
-- Explicit moderation lifecycle for residences.
-- draft -> pending -> approved/rejected -> pending (resubmission)

alter table public.residences
  add column if not exists moderation_status text not null default 'draft',
  add column if not exists moderation_reason text,
  add column if not exists moderated_at timestamptz;

alter table public.residences
  drop constraint if exists residences_moderation_status_check;

alter table public.residences
  add constraint residences_moderation_status_check
  check (moderation_status in ('draft','pending','approved','rejected'));

-- Backfill existing records without changing public visibility.
update public.residences
set moderation_status = case
  when is_published = true and is_verified = true then 'approved'
  when is_published = true and is_verified = false then 'pending'
  else 'draft'
end,
moderation_reason = case
  when is_published = true and is_verified = true then null
  else moderation_reason
end
where moderation_status = 'draft';

create index if not exists residences_moderation_status_idx
  on public.residences (moderation_status, created_at desc);

-- Client users may edit residence content, but publication/verification transitions
-- must happen through the dedicated RPCs below. Admin/security-definer functions
-- run as postgres and are allowed through.
create or replace function public.residences_guard_owner()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() = 'service_role' or auth.role() is null or current_user = 'postgres' or public.is_admin() then
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

drop trigger if exists residences_before_update_owner on public.residences;
create trigger residences_before_update_owner
before update on public.residences
for each row execute procedure public.residences_guard_owner();

-- Submit a draft/rejected listing for moderation.
create or replace function public.submit_residence_for_review(p_residence_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_row public.residences%rowtype;
begin
  select * into v_row
  from public.residences
  where id = p_residence_id and owner_id = auth.uid();

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

-- Withdraw a pending/approved listing voluntarily.
create or replace function public.withdraw_residence_publication(p_residence_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  update public.residences
  set is_published = false,
      moderation_status = case when moderation_status = 'approved' then 'draft' else moderation_status end,
      updated_at = now()
  where id = p_residence_id
    and owner_id = auth.uid()
    and moderation_status in ('pending','approved');

  if not found then
    raise exception 'Bien introuvable ou déjà retiré' using errcode = 'P0002';
  end if;
end;
$$;

-- Admin moderation: approve/reject and persist the decision.
create or replace function public.admin_moderate_residence(
  p_residence_id uuid,
  p_action text,
  p_reason text default ''
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_row public.residences%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Accès réservé à l''administration' using errcode = '42501';
  end if;

  if p_action not in ('approve', 'reject') then
    raise exception 'Action invalide' using errcode = '22023';
  end if;

  select * into v_row from public.residences where id = p_residence_id;
  if v_row.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if v_row.moderation_status <> 'pending' then
    raise exception 'Cette annonce n''est pas en attente de modération' using errcode = 'P0001';
  end if;

  if p_action = 'reject' and v_reason is null then
    raise exception 'Un motif est obligatoire pour un refus' using errcode = '22023';
  end if;

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
      v_row.owner_id, 'system', 'Bien vérifié',
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
      v_row.owner_id, 'system', 'Annonce refusée',
      'Votre bien « ' || v_row.title || ' » nécessite des corrections. Motif : ' || v_reason,
      jsonb_build_object('residence_id', p_residence_id, 'moderation_status', 'rejected', 'reason', v_reason)
    );
  end if;
end;
$$;

revoke execute on function public.submit_residence_for_review(uuid) from public, anon;
revoke execute on function public.withdraw_residence_publication(uuid) from public, anon;
revoke execute on function public.admin_moderate_residence(uuid, text, text) from public, anon;

grant execute on function public.submit_residence_for_review(uuid) to authenticated;
grant execute on function public.withdraw_residence_publication(uuid) to authenticated;
grant execute on function public.admin_moderate_residence(uuid, text, text) to authenticated;
