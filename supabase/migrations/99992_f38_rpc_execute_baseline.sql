-- ============================================================================
-- 99992_f38_rpc_execute_baseline.sql
-- ÉTAPE 2 — F-38, suite (autorisée le 2026-09-25) : convergence des 9
-- privilèges EXECUTE restants sur des RPC applicatives, UNIQUEMENT.
--
-- PÉRIMÈTRE EXACT, RIEN D'AUTRE :
--   - EXECUTE de complete_landlord_onboarding, get_my_billing,
--     list_admin_audit_logs, list_my_conversations, list_my_leases,
--     list_my_payments, list_my_receipts, log_admin_action,
--     report_cash_payment.
--
-- EXPLICITEMENT HORS PÉRIMÈTRE (ne pas ajouter ici) :
--   - le corps d'aucune de ces 9 fonctions (report_cash_payment = F-24,
--     complete_landlord_onboarding/get_my_billing = diffs G→P déjà
--     comptées séparément — non touchés ici) ;
--   - toute policy ;
--   - tout grant de table ;
--   - tout autre EXECUTE (list_reviews et les 22 fonctions trigger =
--     M-01, déjà fait ; open_conversation = M-02a, déjà fait) ;
--   - provider_ref / payments_guard_financial / M-18 ;
--   - propose_visit.
--
-- BASELINE ACL VÉRIFIÉE (2026-09-25, lecture seule, proacl brut) :
--   PROD  (les 9) : {postgres=X/postgres,authenticated=X/postgres,
--                     service_role=X/postgres} — AUCUNE entrée PUBLIC.
--                    has_function_privilege : anon=false, authenticated=true,
--                    service_role=true, public=false.
--   LOCAL (les 9, après M-01+M-02a) :
--                    {=X/postgres,postgres=X/postgres,anon=X/postgres,
--                     authenticated=X/postgres,service_role=X/postgres}
--                    — entrée PUBLIC présente (`=X/postgres` en tête).
--                    has_function_privilege : anon=true, authenticated=true,
--                    service_role=true, PUBLIC=true.
--
-- CONSÉQUENCE : un simple `REVOKE EXECUTE ... FROM anon` serait insuffisant
-- — anon hériterait toujours d'EXECUTE via le grant PUBLIC implicite posé à
-- la création de la fonction (même défaut déjà rencontré et corrigé pour
-- list_reviews dans M-01). Cette migration révoque donc explicitement
-- PUBLIC **et** anon, sur les 9 fonctions, sans autre effet.
--
-- Idempotente (REVOKE sans IF EXISTS échoue seulement si le privilège
-- n'existe pas déjà — non : REVOKE est un no-op silencieux dans ce cas en
-- PostgreSQL, donc rejouable sans erreur). Aucune opération destructive de
-- données.
-- ============================================================================

revoke execute on function public.complete_landlord_onboarding(text, text, text, text, text, text) from public, anon;
revoke execute on function public.get_my_billing() from public, anon;
revoke execute on function public.list_admin_audit_logs(integer, integer, uuid, text, text) from public, anon;
revoke execute on function public.list_my_conversations() from public, anon;
revoke execute on function public.list_my_leases() from public, anon;
revoke execute on function public.list_my_payments() from public, anon;
revoke execute on function public.list_my_receipts() from public, anon;
revoke execute on function public.log_admin_action(text, text, uuid, jsonb, jsonb, jsonb) from public, anon;
revoke execute on function public.report_cash_payment(uuid, numeric, date, date) from public, anon;

-- ---------------------------------------------------------------------------
-- Vérification post-migration : privilèges EFFECTIFS des 3 rôles sur les 9
-- fonctions (pas seulement la présence/absence dans proacl). Échoue si un
-- seul des 9 objets ne correspond pas exactement à la cible.
-- ---------------------------------------------------------------------------

do $$
declare
  v_targets regprocedure[] := array[
    'public.complete_landlord_onboarding(text, text, text, text, text, text)'::regprocedure,
    'public.get_my_billing()'::regprocedure,
    'public.list_admin_audit_logs(integer, integer, uuid, text, text)'::regprocedure,
    'public.list_my_conversations()'::regprocedure,
    'public.list_my_leases()'::regprocedure,
    'public.list_my_payments()'::regprocedure,
    'public.list_my_receipts()'::regprocedure,
    'public.log_admin_action(text, text, uuid, jsonb, jsonb, jsonb)'::regprocedure,
    'public.report_cash_payment(uuid, numeric, date, date)'::regprocedure
  ];
  v_fn regprocedure;
  v_bad text[] := '{}';
begin
  foreach v_fn in array v_targets loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then
      v_bad := array_append(v_bad, v_fn::text || ': anon=true (attendu false)');
    end if;
    if has_function_privilege('public', v_fn, 'EXECUTE') then
      v_bad := array_append(v_bad, v_fn::text || ': PUBLIC=true (attendu false)');
    end if;
    if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      v_bad := array_append(v_bad, v_fn::text || ': authenticated=false (attendu true — hors périmètre)');
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      v_bad := array_append(v_bad, v_fn::text || ': service_role=false (attendu true — hors périmètre)');
    end if;
  end loop;

  if array_length(v_bad, 1) is not null then
    raise exception '99992 (F-38 RPC EXECUTE) : % objet(s) non conformes : %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice 'M-03/F-38 (9 EXECUTE de RPC) : OK — anon refusé, PUBLIC refusé, authenticated et service_role préservés sur les 9 fonctions.';
end;
$$;
