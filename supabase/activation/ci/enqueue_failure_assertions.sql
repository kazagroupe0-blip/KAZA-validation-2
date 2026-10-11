-- Assertions SQL : échec de MISE EN FILE pg_net (CI jetable, base locale activée, local-test).
--   psql -v ON_ERROR_STOP=1 -f supabase/activation/ci/enqueue_failure_assertions.sql
-- Script distinct, donc session distincte : le schéma net est renommé AVANT la première exécution
-- du dispatch dans la session (un plan plpgsql déjà mis en cache résoudrait la fonction par OID et
-- masquerait la panne). Tout est annulé en fin de script.
-- Renommer le schéma net exige d'en être propriétaire, d'être membre du rôle propriétaire, ou d'être superuser. Si ce n'est
-- pas le cas sur la pile locale, le test n'est PAS exécuté et le dit explicitement (ligne
-- ENQUEUE_FAILURE_TEST_SKIPPED relevée par la CI en avertissement) : jamais un faux succès.
select (
    coalesce((select rolsuper from pg_roles where rolname = current_user), false)
    or coalesce(bool_or(pg_has_role(current_user, nspowner, 'member')), false)
  ) as can_rename
  from pg_namespace where nspname = 'net' \gset

\if :can_rename
begin;

create function pg_temp.st(p_name text)
returns public.storage_upload_validations language sql as $$
  select v from public.storage_upload_validations v where v.bucket_id = 'chat-files' and v.object_name = p_name
$$;

-- 8) Échec de MISE EN FILE pg_net : l'upload n'est pas perdu, l'objet reste pending (illisible),
--    l'erreur est tracée, et la reprise cron renvoie ensuite l'envoi.
alter schema net rename to net_f05_down;

insert into storage.objects (bucket_id, name, version, metadata)
values ('chat-files', 'idem/b.jpg', 'ver-b1', '{"mimetype":"image/jpeg","size":40,"eTag":"b1"}');

alter schema net_f05_down rename to net;

do $$
declare r public.storage_upload_validations;
begin
  r := pg_temp.st('idem/b.jpg');
  assert r.status = 'pending', 'an enqueue failure must leave the object pending';
  assert r.last_error is not null, 'the enqueue failure must be recorded';
  assert r.last_request_id is null, 'nothing was enqueued: no request id';
  assert r.retry_attempts = 1, 'the failed attempt was a real attempt';
  assert private.storage_upload_validation_allows_read('chat-files', 'idem/b.jpg') is false,
    'a pending object must stay unreadable';

  update public.storage_upload_validations set last_attempt_at = now() - interval '10 minutes'
   where bucket_id = 'chat-files' and object_name = 'idem/b.jpg';
  perform private.retry_stale_storage_validations();

  r := pg_temp.st('idem/b.jpg');
  assert r.retry_attempts = 2 and r.last_request_id is not null, 'the cron retry must recover the failed enqueue';
end $$;

rollback;
\else
\echo ENQUEUE_FAILURE_TEST_SKIPPED: current_user does not own schema net, the pg_net enqueue failure was NOT exercised
\endif
