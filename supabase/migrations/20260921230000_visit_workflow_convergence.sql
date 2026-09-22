-- 20260921230000_visit_workflow_convergence.sql
-- Converge the web visit workflow on the canonical visits table/RPCs.
-- Proposal is atomic: validate conversation + slots, persist all visits,
-- create one chat request and one landlord notification in the same transaction.

-- Publish business events consumed by already-open participant sessions.
-- Idempotent so the migration is safe if either table is already published.
do $kaza$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'visits'
  ) then
    execute 'alter publication supabase_realtime add table public.visits';
  end if;
end $kaza$;

create or replace function public.propose_visit(
  p_conversation_id uuid,
  p_slots jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.conversations%rowtype;
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

  select * into v_conv
    from public.conversations
   where id = p_conversation_id
   for update;

  if v_conv.id is null then
    raise exception 'Conversation introuvable' using errcode = 'P0002';
  end if;

  if v_conv.tenant_id <> auth.uid() then
    raise exception 'Seul le locataire peut proposer une visite' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.residences r
     where r.id = v_conv.residence_id
       and r.is_published = true
       and r.is_verified = true
       and r.moderation_status = 'approved'
  ) then
    raise exception 'Ce bien n''est plus disponible pour une visite' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) not between 1 and 3 then
    raise exception 'Choisissez entre 1 et 3 créneaux' using errcode = '22023';
  end if;

  -- Validate every slot before writing anything.
  for v_slot in select value from jsonb_array_elements(p_slots)
  loop
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

  -- Reject overlapping alternatives: otherwise the landlord could receive
  -- contradictory slots that are impossible to honor simultaneously.
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

  -- Prevent a second active proposal while one is still waiting.
  if exists (
    select 1
      from public.visits v
     where v.conversation_id = p_conversation_id
       and v.status = 'proposed'
  ) then
    raise exception 'Une proposition de visite est déjà en attente' using errcode = 'P0001';
  end if;

  -- Persist all alternatives atomically.
  for v_slot in select value from jsonb_array_elements(p_slots)
  loop
    v_start := (v_slot->>'start')::timestamptz;
    v_end := (v_slot->>'end')::timestamptz;

    insert into public.visits (
      conversation_id, proposed_by, slot_start, slot_end, status
    )
    values (
      p_conversation_id, auth.uid(), v_start, v_end, 'proposed'
    )
    returning id into v_id;

    v_ids := array_append(v_ids, v_id);

    v_body := v_body ||
      case when v_body = '' then '' else E'\n' end ||
      '📅 ' ||
      to_char(v_start at time zone 'Africa/Porto-Novo', 'DD/MM/YYYY à HH24:MI') ||
      ' → ' ||
      to_char(v_end at time zone 'Africa/Porto-Novo', 'HH24:MI');
  end loop;

  insert into public.messages (conversation_id, sender_id, body, kind)
  values (
    p_conversation_id,
    auth.uid(),
    'Demande de visite' || E'\n' || v_body,
    'visit_request'
  );

  insert into public.notifications (user_id, type, title, body, data)
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
$$;

revoke execute on function public.propose_visit(uuid, jsonb) from public, anon;
grant execute on function public.propose_visit(uuid, jsonb) to authenticated;

-- Canonical confirmation now also closes the alternative proposed slots
-- attached to the same request, preventing stale pending visits.
create or replace function public.confirm_visit(
  p_visit_id uuid,
  p_slot_index int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_conv public.conversations%rowtype;
begin
  select * into v_visit
    from public.visits
   where id = p_visit_id;

  if v_visit.id is null then
    raise exception 'Visite introuvable' using errcode = 'P0002';
  end if;

  if v_visit.status <> 'proposed' then
    raise exception 'Visite déjà traitée' using errcode = 'P0001';
  end if;

  select * into v_conv
    from public.conversations
   where id = v_visit.conversation_id;

  if v_conv.landlord_id <> auth.uid() then
    raise exception 'Seul le bailleur confirme la visite' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.residences r
     where r.id = v_conv.residence_id
       and r.is_published = true
       and r.is_verified = true
       and r.moderation_status = 'approved'
       and r.status = 'libre'
  ) then
    raise exception 'Ce bien n''est plus disponible pour confirmer cette visite' using errcode = 'P0001';
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

  -- Other alternatives from the same pending request are no longer valid.
  update public.visits
     set status = 'cancelled'
   where conversation_id = v_visit.conversation_id
     and proposed_by = v_visit.proposed_by
     and status = 'proposed'
     and id <> p_visit_id;

  insert into public.messages (conversation_id, sender_id, body, kind)
  values (
    v_visit.conversation_id,
    auth.uid(),
    '✅ Visite confirmée pour le ' ||
      to_char(v_visit.slot_start at time zone 'Africa/Porto-Novo', 'DD/MM/YYYY à HH24:MI'),
    'visit_agreed'
  );

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_conv.tenant_id,
    'visit',
    'Visite confirmée',
    'Le bailleur vous reçoit le ' ||
      to_char(v_visit.slot_start at time zone 'Africa/Porto-Novo', 'DD/MM/YYYY à HH24:MI'),
    jsonb_build_object(
      'visit_id', p_visit_id,
      'conversation_id', v_visit.conversation_id
    )
  );

  update public.residences
     set status = 'en_visite'
   where id = v_conv.residence_id
     and status = 'libre';
end;
$$;

revoke execute on function public.confirm_visit(uuid, int) from public, anon;
grant execute on function public.confirm_visit(uuid, int) to authenticated;

do $kaza$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'propose_visit'
      and pg_get_function_identity_arguments(p.oid) = 'p_conversation_id uuid, p_slots jsonb'
  ) then
    raise exception 'propose_visit RPC absente après convergence';
  end if;
end $kaza$;
