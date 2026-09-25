-- ============================================================================
-- 99993_table_grants_baseline.sql
-- ÉTAPE 2 — F-38, bloc des grants de tables (autorisé le 2026-09-25).
-- Portée exacte : GRANT/REVOKE sur les 14 tables listées ci-dessous,
-- UNIQUEMENT pour les rôles `anon` et `authenticated`. Rien d'autre.
--
-- EXPLICITEMENT HORS PÉRIMÈTRE (ne pas ajouter ici) :
--   - service_role (non touché, conserve arwdDxtm partout) ;
--   - PUBLIC (aucun grant PUBLIC observé sur ces tables, rien à faire) ;
--   - toute policy, tout corps de fonction, tout trigger, tout index ;
--   - provider_ref / payments_guard_financial / M-18 ;
--   - propose_visit, les jobs pg_cron, les 8+2 fonctions G→P.
--
-- BASELINE VÉRIFIÉE (2026-09-25, lecture seule, ACL brute +
-- information_schema.role_table_grants, deux méthodes concordantes) :
--   PROD anon  : aucun privilège sur les 14 tables (confirmé, incluant
--                _cron_secrets/admin_audit_logs/app_settings).
--   PROD authenticated : cf. cible ci-dessous.
--   LOCAL (après M-01+M-02a+M-03) : anon ET authenticated ont arwdDxt
--     (INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) sur les 14
--     tables — origine tracée : `alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role` (shim de
--     plateforme, reproduisant le comportement de provisionnement par
--     défaut de Supabase Cloud) puis `9998_restore_table_grants.sql`
--     (grant explicite SIUD). Prod n'accorde jamais TRUNCATE/REFERENCES/
--     TRIGGER à authenticated sur aucune de ces tables : la cible n'est
--     donc pas un simple retrait de SIUD, mais REVOKE ALL puis re-GRANT
--     exact des seuls verbes prouvés en prod.
--
-- Cible authenticated (SELECT/INSERT/UPDATE/DELETE uniquement, jamais
-- TRUNCATE/REFERENCES/TRIGGER, jamais anon) :
--   _cron_secrets=aucun  admin_audit_logs=aucun  app_settings=aucun
--   conversations=S      favorites=aucun          leases=aucun
--   messages=SIU         notifications=SU         payments=U
--   profiles=SU          receipts=aucun           residences=SIUD
--   reviews=aucun        visits=SI
--
-- Idempotente (REVOKE/GRANT explicites, rejouable sans erreur). Aucune
-- opération destructive de données.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A) anon : retrait complet sur les 14 tables.
-- ---------------------------------------------------------------------------

revoke all on table public._cron_secrets from anon;
revoke all on table public.admin_audit_logs from anon;
revoke all on table public.app_settings from anon;
revoke all on table public.conversations from anon;
revoke all on table public.favorites from anon;
revoke all on table public.leases from anon;
revoke all on table public.messages from anon;
revoke all on table public.notifications from anon;
revoke all on table public.payments from anon;
revoke all on table public.profiles from anon;
revoke all on table public.receipts from anon;
revoke all on table public.residences from anon;
revoke all on table public.reviews from anon;
revoke all on table public.visits from anon;

-- ---------------------------------------------------------------------------
-- B) authenticated : retrait total puis re-attribution exacte de la cible
--    prod (REVOKE ALL d'abord, pour ne laisser aucun résidu TRUNCATE/
--    REFERENCES/TRIGGER, puis GRANT des seuls verbes prouvés en prod).
-- ---------------------------------------------------------------------------

revoke all on table public._cron_secrets from authenticated;
revoke all on table public.admin_audit_logs from authenticated;
revoke all on table public.app_settings from authenticated;
revoke all on table public.conversations from authenticated;
revoke all on table public.favorites from authenticated;
revoke all on table public.leases from authenticated;
revoke all on table public.messages from authenticated;
revoke all on table public.notifications from authenticated;
revoke all on table public.payments from authenticated;
revoke all on table public.profiles from authenticated;
revoke all on table public.receipts from authenticated;
revoke all on table public.residences from authenticated;
revoke all on table public.reviews from authenticated;
revoke all on table public.visits from authenticated;

-- _cron_secrets, admin_audit_logs, app_settings, favorites, leases,
-- receipts, reviews : aucun grant à authenticated en prod. Rien à
-- re-accorder (déjà à zéro après le REVOKE ALL ci-dessus).

grant select on table public.conversations to authenticated;
grant select, insert, update on table public.messages to authenticated;
grant select, update on table public.notifications to authenticated;
grant update on table public.payments to authenticated;
grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.residences to authenticated;
grant select, insert on table public.visits to authenticated;

-- ---------------------------------------------------------------------------
-- Vérification post-migration : ACL brute + has_table_privilege pour anon
-- et authenticated, table par table (pas de comparaison agrégée). Échoue
-- si un seul des 14 objets ne correspond pas exactement à la cible.
-- ---------------------------------------------------------------------------

do $$
declare
  -- table -> (select,insert,update,delete) attendu pour authenticated. anon
  -- attendu = (false,false,false,false) pour les 14, invariable.
  v_targets text[][] := array[
    array['_cron_secrets','f','f','f','f'],
    array['admin_audit_logs','f','f','f','f'],
    array['app_settings','f','f','f','f'],
    array['conversations','t','f','f','f'],
    array['favorites','f','f','f','f'],
    array['leases','f','f','f','f'],
    array['messages','t','t','t','f'],
    array['notifications','t','f','t','f'],
    array['payments','f','f','t','f'],
    array['profiles','t','f','t','f'],
    array['receipts','f','f','f','f'],
    array['residences','t','t','t','t'],
    array['reviews','f','f','f','f'],
    array['visits','t','t','f','f']
  ];
  v_row text[];
  v_tbl regclass;
  v_bad text[] := '{}';
begin
  foreach v_row slice 1 in array v_targets loop
    v_tbl := ('public.' || v_row[1])::regclass;

    if has_table_privilege('anon', v_tbl, 'SELECT')
       or has_table_privilege('anon', v_tbl, 'INSERT')
       or has_table_privilege('anon', v_tbl, 'UPDATE')
       or has_table_privilege('anon', v_tbl, 'DELETE')
       or has_table_privilege('anon', v_tbl, 'TRUNCATE')
       or has_table_privilege('anon', v_tbl, 'REFERENCES')
       or has_table_privilege('anon', v_tbl, 'TRIGGER') then
      v_bad := array_append(v_bad, v_row[1] || ': anon possède encore un privilège (attendu: aucun)');
    end if;

    if has_table_privilege('authenticated', v_tbl, 'SELECT') is distinct from (v_row[2] = 't') then
      v_bad := array_append(v_bad, v_row[1] || ': authenticated SELECT = ' || has_table_privilege('authenticated', v_tbl, 'SELECT')::text || ' (attendu ' || v_row[2] || ')');
    end if;
    if has_table_privilege('authenticated', v_tbl, 'INSERT') is distinct from (v_row[3] = 't') then
      v_bad := array_append(v_bad, v_row[1] || ': authenticated INSERT = ' || has_table_privilege('authenticated', v_tbl, 'INSERT')::text || ' (attendu ' || v_row[3] || ')');
    end if;
    if has_table_privilege('authenticated', v_tbl, 'UPDATE') is distinct from (v_row[4] = 't') then
      v_bad := array_append(v_bad, v_row[1] || ': authenticated UPDATE = ' || has_table_privilege('authenticated', v_tbl, 'UPDATE')::text || ' (attendu ' || v_row[4] || ')');
    end if;
    if has_table_privilege('authenticated', v_tbl, 'DELETE') is distinct from (v_row[5] = 't') then
      v_bad := array_append(v_bad, v_row[1] || ': authenticated DELETE = ' || has_table_privilege('authenticated', v_tbl, 'DELETE')::text || ' (attendu ' || v_row[5] || ')');
    end if;
    if has_table_privilege('authenticated', v_tbl, 'TRUNCATE')
       or has_table_privilege('authenticated', v_tbl, 'REFERENCES')
       or has_table_privilege('authenticated', v_tbl, 'TRIGGER') then
      v_bad := array_append(v_bad, v_row[1] || ': authenticated conserve TRUNCATE/REFERENCES/TRIGGER (attendu: aucun des trois)');
    end if;
  end loop;

  if array_length(v_bad, 1) is not null then
    raise exception '99993 (table grants baseline) : % non-conformité(s) : %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice 'M-04/F-38 (14 grants de tables) : OK — anon sans privilège, authenticated identique à la cible prod, sur les 14 tables.';
end;
$$;
