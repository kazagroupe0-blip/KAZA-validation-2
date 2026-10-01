-- Functional A/B audit convergence.
-- Source of behavior: validated Supabase-B visit workflow state.
-- Scope: visit workflow race hardening and message-kind guard.
-- This migration is additive and preserves existing RPC signatures.

create or replace function public.messages_guard_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.kind in ('visit_request', 'visit_agreed', 'visit_cancelled') then
    if auth.role() <> 'service_role'
       and coalesce(current_setting('kaza.internal_visit_message', true), '') <> new.kind then
      raise exception 'Messages de visite réservés au flux de visite' using errcode = '42501';
    end if;
  elsif new.kind = 'system' then
    if auth.role() <> 'service_role' then
      if not exists (
        select 1
          from public.conversations c
         where c.id = new.conversation_id
           and c.landlord_id = auth.uid()
      ) then
        raise exception 'Messages système réservés au bailleur' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.propose_visit(
  p_conversation_id uuid,
  p_slots jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_conv public.conversations%rowtype;
  v_res public.residences%rowtype;
  v_slot jsonb;
  v_start timestamptz;
  v_end timestamptz;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_body text := '';
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'Vous devez être connecté' using errcode = '28000';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id for update;
  if v_conv.id is null then
    raise exception 'Conversation introuvable' using errcode = 'P0002';
  end if;
  if v_conv.tenant_id <> auth.uid() then
    raise exception 'Seul le locataire peut proposer une visite' using errcode = '42501';
  end if;

  select * into v_res from public.residences where id = v_conv.residence_id for update;
  if v_res.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if not (
    v_res.is_published
    and v_res.is_verified
    and v_res.moderation_status = 'approved'
    and v_res.status = 'libre'
  ) then
    raise exception 'Ce bien n''est plus disponible pour une visite' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) not between 1 and 3 then
    raise exception 'Choisissez entre 1 et 3 créneaux' using errcode = '22023';
  end if;

  for v_slot in select value from jsonb_array_elements(p_slots) loop
    if jsonb_typeof(v_slot) <> 'object'
       or not (v_slot ? 'start')
       or not (v_slot ? 'end') then
      raise exception 'Créneau de visite invalide' using errcode = '22023';
    end if;

    begin
      v_start := (v_slot->>'start')::timestamptz;
      v_end := (v_slot->>'end')::timestamptz;
    exception when others then
      raise exception 'Date de créneau invalide' using errcode = '22023';
    end;

    if v_start <= now() then
      raise exception 'Un créneau doit être dans le futur' using errcode = '22023';
    end if;
    if v_end <= v_start then
      raise exception 'La fin du créneau doit être postérieure au début' using errcode = '22023';
    end if;
    if v_end > v_start + interval '4 hours' then
      raise exception 'Un créneau ne peut pas dépasser 4 heures' using errcode = '22023';
    end if;

    v_count := v_count + 1;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_slots) with ordinality a(value, ordinality)
    cross join jsonb_array_elements(p_slots) with ordinality b(value, ordinality)
    where a.ordinality < b.ordinality
      and (a.value->>'start')::timestamptz < (b.value->>'end')::timestamptz
      and (b.value->>'start')::timestamptz < (a.value->>'end')::timestamptz
  ) then
    raise exception 'Les créneaux proposés ne doivent pas se chevaucher' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.visits v
     where v.conversation_id = p_conversation_id
       and v.status = 'proposed'
  ) then
    raise exception 'Une proposition de visite est déjà en attente' using errcode = 'P0001';
  end if;

  for v_slot in select value from jsonb_array_elements(p_slots) loop
    v_start := (v_slot->>'start')::timestamptz;
    v_end := (v_slot->>'end')::timestamptz;

    insert into public.visits (
      conversation_id,
      proposed_by,
      slot_start,
      slot_end,
      status
    )
    values (
      p_conversation_id,
      auth.uid(),
      v_start,
      v_end,
      'proposed'
    )
    returning id into v_id;

    v_ids := array_append(v_ids, v_id);

    v_body := v_body ||
      case when v_body = '' then '' else E'\\n' end ||
      '📅 ' ||
      to_char(v_start at time zone 'Africa/Porto-Novo', 'DD/MM/YYYY à HH24:MI') ||
      ' → ' ||
      to_char(v_end at time zone 'Africa/Porto-Novo', 'HH24:MI');
  end loop;

  perform set_config('kaza.internal_visit_message', 'visit_request', true);
  insert into public.messages (
    conversation_id,
    sender_id,
    body,
    kind
  )
  values (
    p_conversation_id,
    auth.uid(),
    'Demande de visite' || E'\\n' || v_body,
    'visit_request'
  );
  perform set_config('kaza.internal_visit_message', '', true);

  insert into public.notifications (
    user_id,
    type,
    title,
    body,
    data
  )
  values (
    v_conv.landlord_id,
    'visit',
    'Nouvelle demande de visite',
    'Un locataire vous a proposé ' || v_count || ' créneau(x) pour visiter votre bien.',
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'visit_ids', to_jsonb(v_ids)
    )
  );

  return v_ids;
end;
$function$;

create or replace function public.confirm_visit(
  p_visit_id uuid,
  p_slot_index integer
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_visit public.visits%rowtype;
  v_conv public.conversations%rowtype;
  v_res public.residences%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Non authentifié' using errcode = '42501';
  end if;

  select * into v_visit
    from public.visits
   where id = p_visit_id
   for update;

  if v_visit.id is null then
    raise exception 'Visite introuvable' using errcode = 'P0002';
  end if;
  if v_visit.status <> 'proposed' then
    raise exception 'Visite déjà traitée' using errcode = 'P0001';
  end if;

  select * into v_conv
    from public.conversations
   where id = v_visit.conversation_id
   for update;

  if v_conv.id is null then
    raise exception 'Conversation introuvable' using errcode = 'P0002';
  end if;
  if v_conv.landlord_id <> auth.uid() then
    raise exception 'Seul le bailleur confirme la visite' using errcode = '42501';
  end if;

  select * into v_res
    from public.residences
   where id = v_conv.residence_id
   for update;

  if v_res.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if not (
    v_res.is_published
    and v_res.is_verified
    and v_res.moderation_status = 'approved'
    and v_res.status = 'libre'
  ) then
    raise exception 'Ce bien n''est plus disponible pour une visite' using errcode = 'P0001';
  end if;

  update public.visits
     set status = 'confirmed',
         confirmed_by = auth.uid(),
         confirmed_at = now()
   where id = p_visit_id
     and status = 'proposed';

  if not found then
    raise exception 'Visite déjà traitée' using errcode = 'P0001';
  end if;

  update public.visits
     set status = 'cancelled'
   where conversation_id = v_visit.conversation_id
     and proposed_by = v_visit.proposed_by
     and status = 'proposed'
     and id <> p_visit_id;

  perform set_config('kaza.internal_visit_message', 'visit_agreed', true);
  insert into public.messages (
    conversation_id,
    sender_id,
    body,
    kind
  )
  values (
    v_visit.conversation_id,
    auth.uid(),
    '✅ Visite confirmée pour le ' ||
      to_char(v_visit.slot_start at time zone 'Africa/Porto-Novo','DD/MM/YYYY à HH24:MI'),
    'visit_agreed'
  );
  perform set_config('kaza.internal_visit_message', '', true);

  insert into public.notifications (
    user_id,
    type,
    title,
    body,
    data
  )
  values (
    v_conv.tenant_id,
    'visit',
    'Visite confirmée',
    'Le bailleur vous reçoit le ' ||
      to_char(v_visit.slot_start at time zone 'Africa/Porto-Novo','DD/MM/YYYY à HH24:MI'),
    jsonb_build_object(
      'visit_id', p_visit_id,
      'conversation_id', v_visit.conversation_id
    )
  );

  perform set_config('kaza.internal_residence_transition', '1', true);
  update public.residences
     set status = 'en_visite'
   where id = v_conv.residence_id
     and status = 'libre';
  perform set_config('kaza.internal_residence_transition', '0', true);
end;
$function$;

create or replace function public.cancel_visit(
  p_visit_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_visit public.visits%rowtype;
  v_conv public.conversations%rowtype;
  v_res public.residences%rowtype;
  v_cancelled_by text;
begin
  if auth.uid() is null then
    raise exception 'Non authentifié' using errcode = '42501';
  end if;

  select * into v_visit
    from public.visits
   where id = p_visit_id
   for update;

  if v_visit.id is null then
    raise exception 'Visite introuvable' using errcode = 'P0002';
  end if;

  if v_visit.status not in ('proposed','confirmed') then
    raise exception 'Cette visite ne peut plus être annulée' using errcode = 'P0001';
  end if;

  select * into v_conv
    from public.conversations
   where id = v_visit.conversation_id
   for update;

  if v_conv.id is null then
    raise exception 'Conversation introuvable' using errcode = 'P0002';
  end if;

  if not (
    auth.uid() = v_visit.proposed_by
    or coalesce(auth.uid() = v_visit.confirmed_by, false)
    or auth.uid() = v_conv.landlord_id
  ) then
    raise exception 'Vous ne pouvez pas annuler cette visite' using errcode = '42501';
  end if;

  if auth.uid() = v_visit.proposed_by then
    v_cancelled_by := 'locataire';
  elsif auth.uid() = v_conv.landlord_id then
    v_cancelled_by := 'bailleur';
  else
    v_cancelled_by := 'admin';
  end if;

  select * into v_res
    from public.residences
   where id = v_conv.residence_id
   for update;

  if v_res.id is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  update public.visits
     set status = 'cancelled'
   where id = p_visit_id
     and status in ('proposed','confirmed');

  if not found then
    raise exception 'Cette visite ne peut plus être annulée' using errcode = 'P0001';
  end if;

  perform set_config('kaza.internal_visit_message', 'visit_cancelled', true);
  insert into public.messages (
    conversation_id,
    sender_id,
    body,
    kind
  )
  values (
    v_visit.conversation_id,
    auth.uid(),
    'Visite annulee par le ' || v_cancelled_by ||
      case when p_reason is not null and p_reason <> '' then ' (' || p_reason || ')' else '' end,
    'visit_cancelled'
  );
  perform set_config('kaza.internal_visit_message', '', true);

  insert into public.notifications (
    user_id,
    type,
    title,
    body,
    data
  )
  values (
    case when auth.uid() = v_conv.tenant_id then v_conv.landlord_id else v_conv.tenant_id end,
    'visit',
    'Visite annulee',
    'Une visite prevue le ' ||
      to_char(v_visit.slot_start,'DD/MM/YYYY a HH24:MI') ||
      ' a ete annulee.',
    jsonb_build_object(
      'visit_id', p_visit_id,
      'conversation_id', v_visit.conversation_id
    )
  );

  if v_visit.status = 'confirmed' then
    if not exists (
      select 1 from public.leases l
       where l.residence_id = v_conv.residence_id
         and l.status = 'active'
    )
    and not exists (
      select 1
      from public.visits v
      join public.conversations c on c.id = v.conversation_id
      where c.residence_id = v_conv.residence_id
        and v.conversation_id <> v_visit.conversation_id
        and v.status in ('proposed','confirmed')
    ) then
      perform set_config('kaza.internal_residence_transition', '1', true);
      update public.residences
         set status = 'libre'
       where id = v_conv.residence_id
         and status = 'en_visite';
      perform set_config('kaza.internal_residence_transition', '0', true);
    end if;
  end if;
end;
$function$;

create or replace function public.decline_visit(
  p_visit_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_visit public.visits%rowtype;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Non authentifié' using errcode = '42501';
  end if;

  select * into v_visit
    from public.visits
   where id = p_visit_id
   for update;

  if v_visit.id is null then
    raise exception 'Visite introuvable' using errcode = 'P0002';
  end if;

  if v_visit.status <> 'proposed' then
    raise exception 'Seules les visites en attente peuvent être refusées' using errcode = 'P0001';
  end if;

  select * into v_conv
    from public.conversations
   where id = v_visit.conversation_id
   for update;

  if v_conv.id is null then
    raise exception 'Conversation introuvable' using errcode = 'P0002';
  end if;

  if v_conv.landlord_id <> auth.uid() then
    raise exception 'Seul le bailleur peut refuser une visite' using errcode = '42501';
  end if;

  update public.visits
     set status = 'cancelled'
   where id = p_visit_id
     and status = 'proposed';

  if not found then
    raise exception 'Seules les visites en attente peuvent être refusées' using errcode = 'P0001';
  end if;

  perform set_config('kaza.internal_visit_message', 'visit_cancelled', true);
  insert into public.messages (
    conversation_id,
    sender_id,
    body,
    kind
  )
  values (
    v_visit.conversation_id,
    auth.uid(),
    '❌ Proposition de visite refusée' ||
      case when p_reason is not null and p_reason != '' then ' (' || p_reason || ')' else '' end,
    'visit_cancelled'
  );
  perform set_config('kaza.internal_visit_message', '', true);

  insert into public.notifications (
    user_id,
    type,
    title,
    body,
    data
  )
  values (
    v_conv.tenant_id,
    'visit',
    'Proposition refusée',
    'Votre proposition de visite pour le ' ||
      to_char(v_visit.slot_start, 'DD/MM/YYYY à HH24:MI') ||
      ' a été refusée.',
    jsonb_build_object(
      'visit_id', p_visit_id,
      'conversation_id', v_visit.conversation_id
    )
  );
end;
$function$;
