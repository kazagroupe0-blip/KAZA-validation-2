-- ============================================================================
-- 99995_propose_visit_baseline.sql
-- ÉTAPE 2 — M-06 (autorisée le 2026-09-25) : déploiement G→P de
-- public.propose_visit(uuid, jsonb) et de son EXECUTE, UNIQUEMENT.
--
-- SOURCE : bloc extrait à l'identique (lignes 31-217) de
-- `20260921230000_visit_workflow_convergence.sql` : définition de la
-- fonction + `revoke ... from public, anon` + `grant ... to authenticated`.
--
-- EXPLICITEMENT HORS PÉRIMÈTRE (ne pas ajouter ici) :
--   - la redéfinition de confirm_visit du même fichier source (finding
--     sémantique distinct, réservé) ;
--   - les deux `alter publication supabase_realtime add table` du fichier
--     source (visits et notifications déjà publiées en PROD) ;
--   - cancel_visit, decline_visit, agree_visit, open_conversation ;
--   - toute table, colonne, contrainte, policy, trigger, index ;
--   - provider_ref / payments_guard_financial / M-18.
--
-- ÉTAT PROD VÉRIFIÉ (2026-09-25, lecture seule) :
--   - propose_visit absente (aucune signature) ;
--   - dépendances présentes : table visits (colonnes conversation_id,
--     proposed_by, slot_start, slot_end, status visit_status), enum
--     visit_status ('proposed' inclus), messages_kind_check ('visit_request'
--     inclus), notifications ;
--   - RPC sœurs (confirm_visit, cancel_visit, decline_visit,
--     open_conversation) : SECURITY DEFINER, search_path=public, ACL brute
--     {postgres=X, authenticated=X, service_role=X}, aucune entrée anon ni
--     PUBLIC. service_role obtient EXECUTE par les privilèges par défaut du
--     schéma public (aucun GRANT explicite dans ces migrations) ; le même
--     mécanisme s'applique ici, sans GRANT ajouté.
--
-- Version "99995" : trie après "99994" (M-05) et avant "999999".
-- Idempotente (CREATE OR REPLACE, REVOKE/GRANT). Aucune donnée modifiée.
-- ============================================================================

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

  select *
    into v_conv
    from public.conversations
   where id = p_conversation_id
   for update;

  if v_conv.id is null then
    raise exception 'Conversation introuvable' using errcode = 'P0002';
  end if;

  if v_conv.tenant_id <> auth.uid() then
    raise exception 'Seul le locataire peut proposer une visite' using errcode = '42501';
  end if;

  -- Lock the residence while validating availability so the decision cannot
  -- become stale between validation and insertion.
  select *
    into v_res
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

  if jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) not between 1 and 3 then
    raise exception 'Choisissez entre 1 et 3 créneaux' using errcode = '22023';
  end if;

  -- Validate every slot before writing anything.
  for v_slot in
    select value
      from jsonb_array_elements(p_slots)
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

  for v_slot in
    select value
      from jsonb_array_elements(p_slots)
  loop
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
$$;

revoke execute on function public.propose_visit(uuid, jsonb) from public, anon;
grant execute on function public.propose_visit(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Vérification post-migration. Chaque non-conformité est nommée ; une seule
-- exception consolidée est levée si l'une échoue.
-- ---------------------------------------------------------------------------

do $$
declare
  v_oid oid;
  v_bad text[] := '{}';
  v_n int;
begin
  select count(*) into v_n
    from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'propose_visit';
  if v_n <> 1 then
    raise exception '99995 (propose_visit) : % signature(s) propose_visit (attendu exactement 1)', v_n;
  end if;

  v_oid := to_regprocedure('public.propose_visit(uuid, jsonb)');
  if v_oid is null then
    raise exception '99995 (propose_visit) : public.propose_visit(uuid, jsonb) absente';
  end if;

  if pg_get_function_identity_arguments(v_oid) <> 'p_conversation_id uuid, p_slots jsonb' then
    v_bad := array_append(v_bad, 'propose_visit : arguments = ' || pg_get_function_identity_arguments(v_oid));
  end if;
  if pg_get_function_result(v_oid) <> 'uuid[]' then
    v_bad := array_append(v_bad, 'propose_visit : type de retour = ' || pg_get_function_result(v_oid) || ' (attendu uuid[])');
  end if;
  if not (select prosecdef from pg_proc where oid = v_oid) then
    v_bad := array_append(v_bad, 'propose_visit : SECURITY DEFINER absent');
  end if;
  if (select coalesce(proconfig, '{}') from pg_proc where oid = v_oid) <> array['search_path=public'] then
    v_bad := array_append(v_bad, 'propose_visit : proconfig = ' || (select coalesce(proconfig, '{}')::text from pg_proc where oid = v_oid) || ' (attendu {search_path=public})');
  end if;
  if (select md5(prosrc) from pg_proc where oid = v_oid) <> 'a7fb01dadb22f806e1d22a6758f8d487' then
    v_bad := array_append(v_bad, 'propose_visit : corps différent de la source 20260921230000 (md5 prosrc attendu a7fb01dadb22f806e1d22a6758f8d487)');
  end if;

  if has_function_privilege('anon', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'propose_visit : anon peut exécuter (attendu false)');
  end if;
  if has_function_privilege('public', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'propose_visit : PUBLIC peut exécuter (attendu false)');
  end if;
  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'propose_visit : authenticated ne peut pas exécuter (attendu true)');
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'propose_visit : service_role ne peut pas exécuter (attendu true, comme les RPC sœurs en PROD)');
  end if;

  if array_length(v_bad, 1) is not null then
    raise exception '99995 (propose_visit) : % non-conformité(s) : %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '99995 (propose_visit) : OK — signature, SECURITY DEFINER, search_path, corps source et ACL conformes.';
end;
$$;
