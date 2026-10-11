-- Assertions locales (CI jetable uniquement) : reprise, plafond de tentatives, objet manquant, garde SQL.
-- psql -v ON_ERROR_STOP=1 -f <ce fichier>, base locale activée (env local-test). Tout est annulé en fin de script.
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

-- 2) plafond de tentatives -> rejected.
update public.storage_upload_validations
   set retry_attempts = 5, last_attempt_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'ci-retry/a.jpg';

select private.retry_stale_storage_validations();

do $$
begin
  assert (select status from public.storage_upload_validations
           where bucket_id = 'chat-files' and object_name = 'ci-retry/a.jpg') = 'rejected',
         'retry cap must reject';
end $$;

-- 3) objet disparu hors processus normal -> rejected.
insert into storage.objects (bucket_id, name, metadata)
values ('chat-files', 'ci-retry/b.jpg', '{"mimetype":"image/jpeg","size":40}');

select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'chat-files' and name = 'ci-retry/b.jpg';

update public.storage_upload_validations
   set last_attempt_at = now() - interval '10 minutes'
 where bucket_id = 'chat-files' and object_name = 'ci-retry/b.jpg';

select private.retry_stale_storage_validations();

do $$
begin
  assert (select status from public.storage_upload_validations
           where bucket_id = 'chat-files' and object_name = 'ci-retry/b.jpg') = 'rejected',
         'missing object must be rejected';
end $$;

-- 4) garde SQL : MIME/taille invalides et PDF dans residence-photos.
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('residence-photos', 'ci-guard/p.pdf', '{"mimetype":"application/pdf","size":40}');
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'pdf in residence-photos must be refused';

  v_failed := false;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('chat-files', 'ci-guard/n.jpg', '{"mimetype":"image/jpeg"}');
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'missing size must be refused';

  v_failed := false;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('chat-files', 'ci-guard/m.jpg', '{"size":40}');
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'missing mime must be refused';

  v_failed := false;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('chat-files', 'ci-guard/h.jpg', '{"mimetype":"image/jpeg","size":"99999999999999999999999"}');
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'overflowing size must be refused as check_violation';

  v_failed := false;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('chat-files', 'ci-guard/x.jpg', '{"mimetype":"image/jpeg","size":"abc"}');
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'non numeric size must be refused';

  v_failed := false;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('chat-files', 'ci-guard/s.jpg', '{"mimetype":"image/jpeg","size":5}');
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'too small file must be refused';
end $$;

rollback;
