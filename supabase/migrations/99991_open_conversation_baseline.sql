-- ============================================================================
-- 99991_open_conversation_baseline.sql
-- ÉTAPE 2 — M-02a (portée restreinte, autorisée le 2026-09-25) : baseline de
-- reproductibilité pour open_conversation(uuid) UNIQUEMENT.
--
-- PÉRIMÈTRE EXACT, RIEN D'AUTRE :
--   - corps de public.open_conversation(uuid), remplacé par le corps exact
--     de prod (vérifié en lecture le 2026-09-25 : pg_get_functiondef sur le
--     projet qbogbuwnkwqgarbchtyr).
--
-- EXPLICITEMENT HORS PÉRIMÈTRE (ne pas ajouter ici) :
--   - les grants de table (conversations, leases, payments, receipts,
--     residences, notifications) ;
--   - les EXECUTE de RPC hors migration (9 fonctions, cf. préflight) ;
--   - provider_ref / payments_guard_financial (M-03) ;
--   - toute suppression de policy (M-05) ;
--   - tout autre finding.
--
-- POURQUOI CETTE MIGRATION EXISTE
-- ---------------------------------------------------------------------------
-- `20260921003026_residence_publication_contract.sql` durcit
-- open_conversation (contrôle du rôle `locataire`, exige
-- moderation_status='approved' et status='libre'). `999_fix_rls_complete.sql`
-- (créé plus tôt dans le dépôt, mais dont le jeton de version "999" trie
-- APRÈS le jeton "20260921003026" — confirmé le 2026-09-25 avec le vrai
-- moteur Supabase CLI 2.114.0, `db push --db-url ... --include-all`, ordre
-- de comparaison = jeton de version seul, pas le nom de fichier complet)
-- réinstalle une version SANS ces deux contrôles. Sur toute reconstruction
-- depuis Git, la version faible de `999` a donc le dernier mot.
--
-- État actuel vérifié (2026-09-25, lecture seule) :
--   - PROD  : version durcie (rôle locataire + moderation_status='approved'
--     + status='libre'). EXECUTE : anon=false, authenticated=true,
--     service_role=true.
--   - LOCAL (reconstruction depuis main, y compris après M-01) : version
--     faible de `999` (residence publiée+vérifiée seulement, aucun contrôle
--     de rôle). EXECUTE : identique à la prod (anon=false, authenticated=
--     true, service_role=true) — aucun grant à changer ici.
--
-- Aucune fonction ni migration du dépôt n'appelle open_conversation() en
-- interne (vérifié par recherche) : remplacement du corps sans effet de
-- bord sur d'autres objets.
--
-- Version "99991" : trie après "9999" (M-01, préfixe strict) et avant
-- "999999" (comparaison caractère à caractère : '1' < '9' en 5ᵉ position),
-- sans qu'aucun chevauchement d'objet ne rende cet ordre relatif
-- fonctionnellement nécessaire — c'est une convention de lisibilité, pas
-- une dépendance technique.
--
-- Idempotente (CREATE OR REPLACE). Aucune opération destructive de données.
-- ============================================================================

create or replace function public.open_conversation(p_residence_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_role public.user_role;
  v_id uuid;
begin
  select role into v_role
  from public.profiles
  where id = auth.uid();

  if v_role is distinct from 'locataire'::public.user_role then
    raise exception 'Seuls les locataires peuvent contacter un bailleur' using errcode = '42501';
  end if;

  select owner_id into v_owner
    from public.residences
   where id = p_residence_id
     and is_published = true
     and is_verified = true
     and moderation_status = 'approved'
     and status = 'libre';

  if v_owner is null then
    raise exception 'Bien introuvable' using errcode = 'P0002';
  end if;

  if v_owner = auth.uid() then
    raise exception 'Vous ne pouvez pas vous écrire à vous-même' using errcode = 'P0001';
  end if;

  select id into v_id
    from public.conversations
   where residence_id = p_residence_id
     and tenant_id = auth.uid();

  if v_id is null then
    insert into public.conversations (residence_id, landlord_id, tenant_id)
    values (p_residence_id, v_owner, auth.uid())
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vérification post-migration : échoue si le corps n'a pas le durcissement
-- attendu, ou si un objet hors périmètre a été touché par erreur.
-- ---------------------------------------------------------------------------

do $$
begin
  if position('locataire' in pg_get_functiondef('public.open_conversation(uuid)'::regprocedure)) = 0 then
    raise exception '99991 : open_conversation ne contrôle plus le rôle locataire';
  end if;
  if position('moderation_status' in pg_get_functiondef('public.open_conversation(uuid)'::regprocedure)) = 0 then
    raise exception '99991 : open_conversation ne vérifie plus moderation_status';
  end if;
  if position('status = ''libre''' in pg_get_functiondef('public.open_conversation(uuid)'::regprocedure)) = 0 then
    raise exception '99991 : open_conversation ne vérifie plus status = libre';
  end if;
  if has_function_privilege('anon', 'public.open_conversation(uuid)', 'EXECUTE') then
    raise exception '99991 : open_conversation devient exécutable par anon (hors périmètre)';
  end if;
  if not has_function_privilege('authenticated', 'public.open_conversation(uuid)', 'EXECUTE') then
    raise exception '99991 : open_conversation n''est plus exécutable par authenticated (hors périmètre)';
  end if;
  raise notice 'M-02a (open_conversation seul) : OK.';
end;
$$;
