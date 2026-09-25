-- ============================================================================
-- F-17 : list_upcoming_due réservée à service_role.
--
-- Cause : 1000000_production_convergence recrée la fonction (SECURITY
-- DEFINER, aucun filtre sur l'appelant) et accorde EXECUTE à authenticated,
-- annulant le durcissement de 004/010. Tout utilisateur authentifié obtient
-- les baux actifs de toute la plateforme (identifiants, loyer, échéance).
--
-- Seul appelant : supabase/functions/overdue-cron (client service_role).
-- Le tableau de bord bailleur utilise landlord_dashboard_stats(), qui
-- n'appelle pas cette fonction.
--
-- Portée : ACL de public.list_upcoming_due(integer) uniquement. Le corps de
-- la fonction n'est pas recréé (en PROD il contient des fins de ligne CRLF ;
-- il reste tel quel).
-- ============================================================================

revoke execute on function public.list_upcoming_due(integer) from public, anon, authenticated;
grant execute on function public.list_upcoming_due(integer) to service_role;

do $$
declare
  v_oid oid := to_regprocedure('public.list_upcoming_due(integer)');
  v_bad text[] := '{}';
begin
  if v_oid is null then
    raise exception 'F-17 : public.list_upcoming_due(integer) absente';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'list_upcoming_due') <> 1 then
    v_bad := array_append(v_bad, 'plusieurs signatures list_upcoming_due');
  end if;
  if has_function_privilege('public', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'PUBLIC peut exécuter');
  end if;
  if has_function_privilege('anon', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'anon peut exécuter');
  end if;
  if has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'authenticated peut exécuter');
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    v_bad := array_append(v_bad, 'service_role ne peut pas exécuter');
  end if;
  if (select proacl::text from pg_proc where oid = v_oid) <> '{postgres=X/postgres,service_role=X/postgres}' then
    v_bad := array_append(v_bad, 'ACL brute = ' || (select proacl::text from pg_proc where oid = v_oid));
  end if;
  if not (select prosecdef from pg_proc where oid = v_oid)
     or (select coalesce(proconfig, '{}') from pg_proc where oid = v_oid) <> array['search_path=public'] then
    v_bad := array_append(v_bad, 'SECURITY DEFINER ou search_path modifié');
  end if;
  if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) <> '4ba35b48d560921c83dab397ffabee5c' then
    v_bad := array_append(v_bad, 'corps modifié (md5 hors CR attendu 4ba35b48d560921c83dab397ffabee5c)');
  end if;

  if array_length(v_bad, 1) is not null then
    raise exception 'F-17 : % non-conformité(s) : %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;
end;
$$;
