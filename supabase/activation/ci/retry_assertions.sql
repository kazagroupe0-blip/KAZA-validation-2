-- Assertions locales (CI jetable uniquement) : reprise de validation, plafond de tentatives,
-- objet manquant, reprise des suppressions échouées. Les assertions de la garde MIME/taille
-- sont dans guard_assertions.sql.
-- psql -v ON_ERROR_STOP=1 -f <ce fichier>, base locale activée (env local-test). Tout est annulé en fin de script.
-- Les envois pg_net faits ici sont dans une transaction annulée : aucune requête ne part.
begin;

-- 1) pending ancien avec objet présent -> retry_attempts incrémenté, pas de rejet.
insert into storage.objects (bucket_id, name, metadata)
values ('chat-files', 'ci-retry/a.jpg', '{"mimetype":"image/jpeg","size":40}');

update public.storage_upload_validations
   set last_attempt_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'ci-retry/a.jpg';

select private.retry_stale_storage_validations();

do $$
declare r record;
begin
  select * into r from public.storage_upload_validations
   where bucket_id = 'chat-files' and object_name = 'ci-retry/a.jpg';
  assert r.status = 'pending', 'object with remaining attempts must stay pending';
  assert r.retry_attempts = 2, format('retry_attempts expected 2, got %s', r.retry_attempts);
end $$;

-- 2) plafond de tentatives -> rejected, reste non lisible, suppression à reprendre (deleted_at vide).
update public.storage_upload_validations
   set retry_attempts = 5, last_attempt_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'ci-retry/a.jpg';

select private.retry_stale_storage_validations();

do $$
declare r record;
begin
  select * into r from public.storage_upload_validations
   where bucket_id = 'chat-files' and object_name = 'ci-retry/a.jpg';
  assert r.status = 'rejected', 'retry cap must reject';
  assert r.deleted_at is null, 'object still present: deletion must remain to be done';
  assert private.storage_upload_validation_allows_read('chat-files', 'ci-retry/a.jpg') is false,
    'a rejected object must stay unreadable';
end $$;

-- 3) objet disparu hors processus normal -> rejected, suppression considérée acquise.
insert into storage.objects (bucket_id, name, metadata)
values ('chat-files', 'ci-retry/b.jpg', '{"mimetype":"image/jpeg","size":40}');

select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'chat-files' and name = 'ci-retry/b.jpg';

update public.storage_upload_validations
   set last_attempt_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'ci-retry/b.jpg';

select private.retry_stale_storage_validations();

do $$
declare r record;
begin
  select * into r from public.storage_upload_validations
   where bucket_id = 'chat-files' and object_name = 'ci-retry/b.jpg';
  assert r.status = 'rejected', 'missing object must be rejected';
  assert r.deleted_at is not null, 'missing object: nothing left to delete';
end $$;

-- 4) REPRISE DES SUPPRESSIONS : un rejeté dont l'objet est toujours là est renvoyé au validateur,
--    jamais lisible, et le nombre de tentatives est borné.
insert into storage.objects (bucket_id, name, metadata)
values ('chat-files', 'ci-retry/c.jpg', '{"mimetype":"image/jpeg","size":40}');

update public.storage_upload_validations
   set status = 'rejected', rejection_reason = 'deletion failed earlier',
       updated_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'ci-retry/c.jpg';

do $$
declare n integer;
begin
  assert private.storage_upload_validation_allows_read('chat-files', 'ci-retry/c.jpg') is false,
    'rejected object must be unreadable before the retry';
  n := private.retry_stale_storage_validations();
  assert n >= 1, 'the failed deletion must be queued again';
  assert (select delete_attempts from public.storage_upload_validations where object_name = 'ci-retry/c.jpg') = 1,
    'delete_attempts must be incremented';
  assert (select status from public.storage_upload_validations where object_name = 'ci-retry/c.jpg') = 'rejected';
  assert (select deleted_at from public.storage_upload_validations where object_name = 'ci-retry/c.jpg') is null;
  assert private.storage_upload_validation_allows_read('chat-files', 'ci-retry/c.jpg') is false,
    'rejected object must stay unreadable while its deletion is retried';
end $$;

-- Pas de nouvel envoi avant 5 minutes, ni au-delà de 5 tentatives.
do $$
begin
  perform private.retry_stale_storage_validations();
  assert (select delete_attempts from public.storage_upload_validations where object_name = 'ci-retry/c.jpg') = 1,
    'no new deletion attempt before the 5 minute delay';

  update public.storage_upload_validations
     set delete_attempts = 5, updated_at = now() - interval '10 minutes'
   where object_name = 'ci-retry/c.jpg';
  perform private.retry_stale_storage_validations();
  assert (select delete_attempts from public.storage_upload_validations where object_name = 'ci-retry/c.jpg') = 5,
    'deletion attempts are capped at 5';
  assert (select status from public.storage_upload_validations where object_name = 'ci-retry/c.jpg') = 'rejected';
  assert private.storage_upload_validation_allows_read('chat-files', 'ci-retry/c.jpg') is false,
    'a rejected object whose deletion keeps failing must never become readable';
end $$;

-- 5) rejeté, objet disparu entre-temps : la suppression est enregistrée par la reprise.
insert into storage.objects (bucket_id, name, metadata)
values ('chat-files', 'ci-retry/d.jpg', '{"mimetype":"image/jpeg","size":40}');

update public.storage_upload_validations
   set status = 'rejected', rejection_reason = 'x', updated_at = now() - interval '10 minutes'
 where object_name = 'ci-retry/d.jpg';

select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'chat-files' and name = 'ci-retry/d.jpg';

select private.retry_stale_storage_validations();

do $$
begin
  assert (select deleted_at from public.storage_upload_validations where object_name = 'ci-retry/d.jpg') is not null,
    'rejected + absent object: deletion must be recorded';
end $$;

-- 6) un objet validé n'est jamais touché par la reprise.
insert into storage.objects (bucket_id, name, metadata)
values ('chat-files', 'ci-retry/e.jpg', '{"mimetype":"image/jpeg","size":40}');

update public.storage_upload_validations
   set status = 'validated', validated_at = now(), last_attempt_at = now() - interval '10 minutes',
       updated_at = now() - interval '10 minutes'
 where object_name = 'ci-retry/e.jpg';

select private.retry_stale_storage_validations();

do $$
begin
  assert (select status from public.storage_upload_validations where object_name = 'ci-retry/e.jpg') = 'validated';
  assert (select retry_attempts from public.storage_upload_validations where object_name = 'ci-retry/e.jpg') = 1,
    'a validated row must not be retried';
  assert exists (select 1 from storage.objects where bucket_id = 'chat-files' and name = 'ci-retry/e.jpg');
end $$;

rollback;
