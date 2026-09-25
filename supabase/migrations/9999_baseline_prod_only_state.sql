-- ============================================================================
-- 9999_baseline_prod_only_state.sql
-- ÉTAPE 2 — M-01 : baseline de reproductibilité (préflight KAZA_PHASE3B,
-- matrice M-01 verrouillée le 2026-09-25).
--
-- Portée EXACTE (rien d'autre) :
--   A) search_path épinglé sur 4 fonctions déjà identiques en corps
--      (touch_updated_at, messages_guard_read_only,
--       notifications_guard_read_only, payments_guard_immutable) ;
--   B) notifications_push_columns_guard : garde de prod
--      (auth.role() <> 'service_role', SECURITY DEFINER, search_path) ;
--   C) EXECUTE restreint à service_role sur les 22 fonctions trigger
--      listées explicitement (P→G) + _allowed_upload_mime(text) ;
--   D) EXECUTE anon révoqué sur list_reviews(uuid) (conservé pour
--      authenticated) ;
--   E) index GIN sur residences.features (idempotent).
--
-- EXPLICITEMENT HORS PÉRIPHÈTRE (ne pas ajouter ici) :
--   - open_conversation() et les grants/EXECUTE de conversations/leases/
--     payments/receipts/residences/notifications (M-02a) ;
--   - la règle provider_ref de payments_guard_financial (M-03) ;
--   - la cible fail-closed provider_ref (M-18) ;
--   - toute suppression de policy (M-05) ;
--   - les jobs pg_cron (décision en attente, M-01b ou M-01, non tranchée) ;
--   - rls_auto_enable/ensure_rls et toute extension (capacités de
--     plateforme, jamais rapatriées comme migration KAZA).
--
-- Ne modifie AUCUN autre objet. N'exécute AUCUNE opération destructive de
-- données (aucun DROP TABLE, aucun DELETE). Idempotente (CREATE OR REPLACE /
-- IF NOT EXISTS / REVOKE-GRANT explicites, rejouable sans erreur).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A) search_path épinglé — corps métier inchangé (vérifié identique à la
--    prod au hash normalisé avant écriture ; préflight §M-01).
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.messages_guard_read_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.conversation_id := old.conversation_id;
  new.sender_id := old.sender_id;
  new.body := old.body;
  new.attachments := old.attachments;
  new.kind := old.kind;
  new.created_at := old.created_at;
  return new;
end;
$$;

create or replace function public.notifications_guard_read_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.user_id := old.user_id;
  new.title := old.title;
  new.body := old.body;
  new.type := old.type;
  new.data := old.data;
  new.created_at := old.created_at;
  return new;
end;
$$;

create or replace function public.payments_guard_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'confirmed' then
    raise exception 'Un paiement confirmé est immuable' using errcode = '42501';
  end if;
  if new.status = 'confirmed' and new.confirmed_at is null then
    raise exception 'confirmed_at requis pour confirmer' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- B) notifications_push_columns_guard — garde de prod (auth.role(), pas
--    current_user ; SECURITY DEFINER ; search_path). Seule fonction dont le
--    CORPS change dans cette migration ; portée limitée à cette garde.
-- ---------------------------------------------------------------------------

create or replace function public.notifications_push_columns_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and auth.role() is not null then
    new.push_sent_at := old.push_sent_at;
    new.push_claimed_at := old.push_claimed_at;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- C) EXECUTE restreint à service_role — 22 fonctions trigger listées
--    explicitement (dérivées : 29 fonctions trigger exposées en local moins
--    les 7 qui restent exposées en prod car créées après le durcissement
--    d'origine ; préflight §M-01 #2). Aucune boucle générique : liste figée,
--    revue à chaque nouvelle fonction trigger.
-- ---------------------------------------------------------------------------

revoke execute on function public._guard_storage_upload() from public, anon, authenticated;
revoke execute on function public.enforce_freemium_limit() from public, anon, authenticated;
revoke execute on function public.enforce_freemium_limit_update() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.messages_guard_kind() from public, anon, authenticated;
revoke execute on function public.messages_guard_read_only() from public, anon, authenticated;
revoke execute on function public.notifications_guard_read_only() from public, anon, authenticated;
revoke execute on function public.notifications_push_columns_guard() from public, anon, authenticated;
revoke execute on function public.on_conversation_created() from public, anon, authenticated;
revoke execute on function public.on_message_inserted() from public, anon, authenticated;
revoke execute on function public.on_payment_changed() from public, anon, authenticated;
revoke execute on function public.on_payment_inserted() from public, anon, authenticated;
revoke execute on function public.on_receipt_created() from public, anon, authenticated;
revoke execute on function public.payments_before_update_guard() from public, anon, authenticated;
revoke execute on function public.payments_guard_financial() from public, anon, authenticated;
revoke execute on function public.payments_guard_immutable() from public, anon, authenticated;
revoke execute on function public.profiles_guard_insert() from public, anon, authenticated;
revoke execute on function public.profiles_guard_sensitive() from public, anon, authenticated;
revoke execute on function public.profiles_guard_verification() from public, anon, authenticated;
revoke execute on function public.residences_guard_owner() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.validate_cash_payment_amount() from public, anon, authenticated;

grant execute on function public._guard_storage_upload() to service_role;
grant execute on function public.enforce_freemium_limit() to service_role;
grant execute on function public.enforce_freemium_limit_update() to service_role;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.messages_guard_kind() to service_role;
grant execute on function public.messages_guard_read_only() to service_role;
grant execute on function public.notifications_guard_read_only() to service_role;
grant execute on function public.notifications_push_columns_guard() to service_role;
grant execute on function public.on_conversation_created() to service_role;
grant execute on function public.on_message_inserted() to service_role;
grant execute on function public.on_payment_changed() to service_role;
grant execute on function public.on_payment_inserted() to service_role;
grant execute on function public.on_receipt_created() to service_role;
grant execute on function public.payments_before_update_guard() to service_role;
grant execute on function public.payments_guard_financial() to service_role;
grant execute on function public.payments_guard_immutable() to service_role;
grant execute on function public.profiles_guard_insert() to service_role;
grant execute on function public.profiles_guard_sensitive() to service_role;
grant execute on function public.profiles_guard_verification() to service_role;
grant execute on function public.residences_guard_owner() to service_role;
grant execute on function public.touch_updated_at() to service_role;
grant execute on function public.validate_cash_payment_amount() to service_role;

-- Corps déjà identique prod/local (hash normalisé égal, vérifié en préflight) ;
-- seul l'EXECUTE diverge.
revoke execute on function public._allowed_upload_mime(text) from public, anon, authenticated;
grant execute on function public._allowed_upload_mime(text) to service_role;

-- ---------------------------------------------------------------------------
-- D) list_reviews : retirer PUBLIC et anon (EXECUTE est accordé à PUBLIC par
--    défaut à la création d'une fonction ; un REVOKE limité à `anon` ne
--    suffit pas, `has_function_privilege('anon', …)` reste vrai via PUBLIC),
--    conserver authenticated (état de prod).
-- ---------------------------------------------------------------------------

revoke execute on function public.list_reviews(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- E) Index GIN sur residences.features (présent en prod ; absent en local ;
--    idempotent, ne présuppose aucun état de données).
-- ---------------------------------------------------------------------------

create index if not exists residences_features_gin_idx
  on public.residences using gin (features);

-- ---------------------------------------------------------------------------
-- Vérifications post-migration (échouent la migration si la baseline n'est
-- pas atteinte ; aucune ne touche à un objet hors périmètre).
-- ---------------------------------------------------------------------------

do $$
begin
  if position('set search_path to ''public''' in lower(pg_get_functiondef('public.touch_updated_at()'::regprocedure))) = 0 then
    raise exception 'M-01 : touch_updated_at search_path non épinglé';
  end if;
  if position('set search_path to ''public''' in lower(pg_get_functiondef('public.messages_guard_read_only()'::regprocedure))) = 0 then
    raise exception 'M-01 : messages_guard_read_only search_path non épinglé';
  end if;
  if position('set search_path to ''public''' in lower(pg_get_functiondef('public.notifications_guard_read_only()'::regprocedure))) = 0 then
    raise exception 'M-01 : notifications_guard_read_only search_path non épinglé';
  end if;
  if position('set search_path to ''public''' in lower(pg_get_functiondef('public.payments_guard_immutable()'::regprocedure))) = 0 then
    raise exception 'M-01 : payments_guard_immutable search_path non épinglé';
  end if;

  if position('auth.role()' in pg_get_functiondef('public.notifications_push_columns_guard()'::regprocedure)) = 0 then
    raise exception 'M-01 : notifications_push_columns_guard n''utilise pas auth.role()';
  end if;

  if has_function_privilege('anon', 'public.touch_updated_at()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.touch_updated_at()', 'EXECUTE') then
    raise exception 'M-01 : touch_updated_at reste exposée hors service_role';
  end if;
  if has_function_privilege('anon', 'public._allowed_upload_mime(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._allowed_upload_mime(text)', 'EXECUTE') then
    raise exception 'M-01 : _allowed_upload_mime reste exposée hors service_role';
  end if;
  if has_function_privilege('anon', 'public.list_reviews(uuid)', 'EXECUTE') then
    raise exception 'M-01 : list_reviews reste exécutable par anon';
  end if;
  if not has_function_privilege('authenticated', 'public.list_reviews(uuid)', 'EXECUTE') then
    raise exception 'M-01 : list_reviews n''est plus exécutable par authenticated (hors périmètre)';
  end if;

  if to_regclass('public.residences_features_gin_idx') is null then
    raise exception 'M-01 : index residences_features_gin_idx absent';
  end if;

  raise notice 'M-01 (baseline_prod_only_state) : OK.';
end;
$$;
