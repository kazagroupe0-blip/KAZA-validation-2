-- ============================================================================
-- 99994_cron_visit_push_baseline.sql
-- ÉTAPE 2 — F-38 suite, bloc pg_cron (autorisé le 2026-09-25) : convergence
-- de 2 des 4 jobs pg_cron KAZA UNIQUEMENT.
--
-- PÉRIMÈTRE EXACT, RIEN D'AUTRE :
--   - `visit-reminders-daily` (rescheduled avec le contrat x-cron-secret) ;
--   - `push-emitter-minutely` (rescheduled avec le contrat x-cron-secret).
--
-- EXPLICITEMENT HORS PÉRIMÈTRE (ne pas ajouter ici) :
--   - `overdue-cron-daily` (déjà conforme à la cible prod, prouvé identique
--     par empreinte normalisée : aucun changement nécessaire) ;
--   - `landlord-payouts-every-5-min` (idem, déjà conforme) ;
--   - la table `_cron_secrets` (contenu et structure inchangés) ;
--   - toute fonction, tout grant, toute policy, tout index ;
--   - provider_ref / payments_guard_financial / M-18 ;
--   - les 12 écarts G→P restants.
--
-- ORIGINE DE L'ÉCART (investigation en lecture seule du 2026-09-25,
-- démontrée par `cron.job_run_details` et par hash normalisé côté serveur
-- prod, sans jamais lire ni afficher de texte de commande brut prod) :
--   La prod a exécuté `1000000_production_convergence.sql` (jobids 3/4/5,
--   1ers runs 2026-09-19) APRÈS `20260908232309_production_security_final.sql`
--   (jobid 1, 1er run 2026-09-10, 9 échecs/9, extension/GUC absents) et
--   `20260914_push_notifications.sql` (jobid 2, 1er run 2026-09-14, 6060
--   succès/190 échecs). `1000000` a donc remplacé les définitions faibles
--   par le contrat x-cron-secret + repli `_cron_secrets`.
--   Le jeton de version de `1000000` trie cependant AVANT `20260908232309`
--   et `20260914` : une reconstruction Git depuis zéro réapplique donc les
--   définitions plus anciennes, moins robustes, en dernier — même
--   mécanisme que la régression `open_conversation` corrigée en M-02a.
--   Preuve détaillée : rapport d'investigation du 2026-09-25 (session),
--   jamais un texte de commande prod n'a été lu ni affiché.
--
-- CIBLE (texte repris à l'identique de `1000000_production_convergence.sql`,
-- seule source dont l'empreinte normalisée est prouvée égale à celle
-- actuellement active en prod pour ces 2 jobs — vérifié côté serveur prod
-- via `md5(lower(regexp_replace(command,'\s+','','g')))`, jamais par lecture
-- du texte) :
--   visit-reminders-daily : cible = 0df6a3cb2e3456069b9e085986528456
--   push-emitter-minutely : cible = d8713e307021310c1c8184776d2453bc
--
-- PRÉREQUIS D'ENVIRONNEMENT — ÉCHEC EXPLICITE, JAMAIS DE SAUT SILENCIEUX.
-- Contrairement à `1000000` (qui `raise notice` et sort silencieusement si
-- `pg_cron`/`pg_net` sont absents), cette migration ÉCHOUE explicitement.
--
-- Idempotente (cron.unschedule puis cron.schedule, rejouable sans erreur).
-- Aucune opération destructive de données. Aucun secret dans ce fichier :
-- les commandes ne font que RÉFÉRENCER des noms de clé (`_cron_secrets`,
-- `app.settings.*`), jamais une valeur.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    raise exception '99994 (cron visit/push baseline) : extension pg_cron absente — prérequis d''environnement non satisfait, migration refusée (aucun saut silencieux)';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    raise exception '99994 (cron visit/push baseline) : extension pg_net absente — prérequis d''environnement non satisfait, migration refusée (aucun saut silencieux)';
  end if;
  if to_regclass('public._cron_secrets') is null then
    raise exception '99994 (cron visit/push baseline) : table public._cron_secrets absente — prérequis applicatif non satisfait';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- visit-reminders-daily
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    perform cron.unschedule('visit-reminders-daily');
  exception when others then
    null;
  end;
end;
$$;

select cron.schedule('visit-reminders-daily', '0 7 * * *', $cronjob$
    select net.http_post(
      url := coalesce(
        nullif(current_setting('app.settings.supabase_url', true), ''),
        (select secret from public._cron_secrets where name = 'supabase_url')
      ) || '/functions/v1/visit-reminders',
      headers := jsonb_build_object(
        'x-cron-secret',
        coalesce(
          (select secret from public._cron_secrets where name = 'visit-reminders'),
          nullif(current_setting('app.settings.cron_secret', true), '')
        )
      ),
      body := '{}'::jsonb
    );
  $cronjob$);

-- ---------------------------------------------------------------------------
-- push-emitter-minutely
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    perform cron.unschedule('push-emitter-minutely');
  exception when others then
    null;
  end;
end;
$$;

select cron.schedule('push-emitter-minutely', '* * * * *', $cronjob$
    select net.http_post(
      url := coalesce(
        nullif(current_setting('app.settings.supabase_url', true), ''),
        (select secret from public._cron_secrets where name = 'supabase_url')
      ) || '/functions/v1/push-emitter',
      headers := jsonb_build_object(
        'x-cron-secret',
        coalesce(
          (select secret from public._cron_secrets where name = 'push-emitter'),
          nullif(current_setting('app.settings.cron_secret', true), '')
        )
      ),
      body := '{}'::jsonb
    );
  $cronjob$);

-- ---------------------------------------------------------------------------
-- Vérification post-migration : empreinte normalisée des 4 jobs (pas
-- seulement les 2 modifiés), horaire et activation inchangés. Échoue si un
-- seul écart n'est pas exactement celui attendu.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text[] := '{}';
  v_targets text[][] := array[
    array['visit-reminders-daily', '0 7 * * *', '0df6a3cb2e3456069b9e085986528456'],
    array['push-emitter-minutely', '* * * * *', 'd8713e307021310c1c8184776d2453bc'],
    array['overdue-cron-daily',    '0 8 * * *', 'e1e7dfeaaa9b520d7a1644c0e8c01f74'],
    array['landlord-payouts-every-5-min', '*/5 * * * *', 'ed9b42c826a301ad506c9797a7ca282b']
  ];
  v_row text[];
  v_rec record;
  v_found boolean;
begin
  foreach v_row slice 1 in array v_targets loop
    v_found := false;
    for v_rec in select schedule, active, md5(lower(regexp_replace(command,'\s+','','g'))) as h
                 from cron.job where jobname = v_row[1]
    loop
      v_found := true;
      if v_rec.schedule <> v_row[2] then
        v_bad := array_append(v_bad, v_row[1] || ': schedule = ' || v_rec.schedule || ' (attendu ' || v_row[2] || ')');
      end if;
      if not v_rec.active then
        v_bad := array_append(v_bad, v_row[1] || ': job inactif (attendu actif)');
      end if;
      if v_rec.h <> v_row[3] then
        v_bad := array_append(v_bad, v_row[1] || ': empreinte normalisée = ' || v_rec.h || ' (attendu ' || v_row[3] || ')');
      end if;
    end loop;
    if not v_found then
      v_bad := array_append(v_bad, v_row[1] || ': job absent de cron.job');
    end if;
  end loop;

  if (select count(*) from cron.job) <> 4 then
    v_bad := array_append(v_bad, 'nombre de jobs cron.job = ' || (select count(*) from cron.job)::text || ' (attendu 4 — aucun job créé ou supprimé hors périmètre)');
  end if;

  if array_length(v_bad, 1) is not null then
    raise exception '99994 (cron visit/push baseline) : % non-conformité(s) : %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '99994 (cron visit/push baseline) : OK — visit-reminders-daily et push-emitter-minutely convergés vers la cible prod ; overdue-cron-daily et landlord-payouts-every-5-min inchangés ; 4 jobs au total.';
end;
$$;
