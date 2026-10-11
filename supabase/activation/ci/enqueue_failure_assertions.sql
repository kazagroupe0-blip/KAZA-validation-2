-- Assertions SQL : échec de MISE EN FILE pg_net (CI jetable, base locale activée, local-test).
-- Injecte une exception exactement à l'appel net.http_post, dans la transaction de test.
-- La définition initiale est sauvegardée puis restaurée avant le test de reprise cron.
-- La transaction est annulée à la fin : aucune modification de fonction ne persiste.
\set ON_ERROR_STOP on
begin;

do $owner$
declare v_owner text;
begin
  select pg_get_userbyid(p.proowner) into strict v_owner
    from pg_proc p
   where p.oid = 'private.dispatch_storage_validation_webhook()'::regprocedure;
  assert v_owner = current_user,
    format('CI role %s must own private.dispatch_storage_validation_webhook(), actual owner %s', current_user, v_owner);
end
$owner$;

create temporary table f05_dispatch_backup(definition text) on commit drop;
insert into pg_temp.f05_dispatch_backup(definition)
select pg_get_functiondef('private.dispatch_storage_validation_webhook()'::regprocedure);

do $inject$
declare
  v_definition text;
  v_modified text;
  v_needle constant text := 'v_req := net.http_post(';
  v_count integer;
begin
  select definition into strict v_definition from pg_temp.f05_dispatch_backup;
  v_count := (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle);
  assert v_count = 1, format('Expected exactly one net.http_post call in dispatch function; found %s', v_count);

  v_modified := replace(
    v_definition,
    v_needle,
    'raise exception ''CI injected enqueue failure''; ' || v_needle
  );
  execute v_modified;
end
$inject$;

create function pg_temp.st(p_name text)
returns public.storage_upload_validations language sql as $$
  select v from public.storage_upload_validations v
   where v.bucket_id = 'chat-files' and v.object_name = p_name
$$;

-- L'exception simulée doit être capturée par le gestionnaire d'erreur d'enqueue :
-- l'objet reste pending/illisible, l'erreur est consignée et aucun request id n'est enregistré.
insert into storage.objects (bucket_id, name, version, metadata)
values ('chat-files', 'idem/b.jpg', 'ver-b1', '{"mimetype":"image/jpeg","size":40,"eTag":"b1"}');

do $failure$
declare r public.storage_upload_validations;
begin
  r := pg_temp.st('idem/b.jpg');
  assert r.status = 'pending', 'an enqueue failure must leave the object pending';
  assert r.last_error like '%CI injected enqueue failure%', 'the injected failure must be recorded';
  assert r.last_request_id is null, 'nothing was enqueued: no request id';
  assert r.retry_attempts = 1, 'the failed attempt was a real attempt';
  assert private.storage_upload_validation_allows_read('chat-files', 'idem/b.jpg') is false,
    'a pending object must stay unreadable';
end
$failure$;

-- Restaurer la fonction originale avant l'appel de reprise : le retry exerce le vrai dispatcher.
do $restore$
declare v_definition text;
begin
  select definition into strict v_definition from pg_temp.f05_dispatch_backup;
  execute v_definition;
end
$restore$;

update public.storage_upload_validations
   set last_attempt_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'idem/b.jpg';

select private.retry_stale_storage_validations();

do $retry$
declare r public.storage_upload_validations;
begin
  r := pg_temp.st('idem/b.jpg');
  assert r.retry_attempts = 2 and r.last_request_id is not null,
    'cron retry must recover the failed enqueue using the original dispatcher';
end
$retry$;

rollback;
