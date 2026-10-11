-- Assertions SQL de la machine d'états : un état terminal ne se renverse jamais.
-- CI jetable uniquement, base locale ACTIVÉE. Tout est annulé en fin de script.
--   psql -v ON_ERROR_STOP=1 -f supabase/activation/ci/state_machine_assertions.sql
begin;

create function pg_temp.must_fail(p_sql text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when check_violation then
    return;
  end;
  raise exception 'ASSERTION FAILED (must raise check_violation): %', p_label;
end $$;

insert into storage.objects (bucket_id, name, metadata) values
  ('chat-files', 'sm/validated.jpg', '{"mimetype":"image/jpeg","size":40}'),
  ('chat-files', 'sm/rejected.jpg',  '{"mimetype":"image/jpeg","size":40}'),
  ('chat-files', 'sm/pending.jpg',   '{"mimetype":"image/jpeg","size":40}');

-- pending -> validated, pending -> rejected : autorisés (transition conditionnelle).
do $$
declare n integer;
begin
  update public.storage_upload_validations
     set status = 'validated', validated_at = now(), detected_mime = 'image/jpeg'
   where bucket_id = 'chat-files' and object_name = 'sm/validated.jpg' and status = 'pending';
  get diagnostics n = row_count;
  assert n = 1, 'pending -> validated must succeed once';

  update public.storage_upload_validations
     set status = 'rejected', rejection_reason = 'test'
   where bucket_id = 'chat-files' and object_name = 'sm/rejected.jpg' and status = 'pending';
  get diagnostics n = row_count;
  assert n = 1, 'pending -> rejected must succeed once';
end $$;

-- Transition CONDITIONNELLE : un événement tardif ne touche aucune ligne déjà terminale.
do $$
declare n integer;
begin
  update public.storage_upload_validations
     set status = 'rejected', rejection_reason = 'late invalid event'
   where bucket_id = 'chat-files' and object_name = 'sm/validated.jpg' and status = 'pending';
  get diagnostics n = row_count;
  assert n = 0, 'a late reject must not match a validated row';

  update public.storage_upload_validations
     set status = 'validated', validated_at = now()
   where bucket_id = 'chat-files' and object_name = 'sm/rejected.jpg' and status = 'pending';
  get diagnostics n = row_count;
  assert n = 0, 'a late validation must not match a rejected row';

  assert (select status from public.storage_upload_validations where object_name = 'sm/validated.jpg') = 'validated';
  assert (select status from public.storage_upload_validations where object_name = 'sm/rejected.jpg') = 'rejected';
end $$;

-- Même une écriture INCONDITIONNELLE (bug, upsert, autre outil) ne renverse pas un état terminal.
select pg_temp.must_fail(
  $q$update public.storage_upload_validations set status = 'rejected', validated_at = null where object_name = 'sm/validated.jpg'$q$,
  'validated -> rejected');
select pg_temp.must_fail(
  $q$update public.storage_upload_validations set status = 'pending', validated_at = null where object_name = 'sm/validated.jpg'$q$,
  'validated -> pending');
select pg_temp.must_fail(
  $q$update public.storage_upload_validations set status = 'validated', validated_at = now() where object_name = 'sm/rejected.jpg'$q$,
  'rejected -> validated');
select pg_temp.must_fail(
  $q$update public.storage_upload_validations set status = 'pending' where object_name = 'sm/rejected.jpg'$q$,
  'rejected -> pending');
select pg_temp.must_fail(
  $q$insert into public.storage_upload_validations (bucket_id, object_name, status, validated_at)
     values ('chat-files', 'sm/validated.jpg', 'rejected', null)
     on conflict (bucket_id, object_name) do update set status = excluded.status, validated_at = excluded.validated_at$q$,
  'upsert-style overwrite of a validated row');

-- Un rejeté dont la suppression est enregistrée ne peut pas la « désenregistrer ».
update public.storage_upload_validations set deleted_at = now()
 where bucket_id = 'chat-files' and object_name = 'sm/rejected.jpg';
select pg_temp.must_fail(
  $q$update public.storage_upload_validations set deleted_at = null where object_name = 'sm/rejected.jpg'$q$,
  'rejected deleted_at reset');

-- Lecture : seul validated est lisible ; pending et rejected non ; une ligne absente = historique lisible.
do $$
begin
  assert private.storage_upload_validation_allows_read('chat-files', 'sm/validated.jpg') is true;
  assert private.storage_upload_validation_allows_read('chat-files', 'sm/rejected.jpg') is false, 'rejected must stay unreadable';
  assert private.storage_upload_validation_allows_read('chat-files', 'sm/pending.jpg') is false, 'pending must be unreadable';
  assert private.storage_upload_validation_allows_read('chat-files', 'sm/unknown-legacy.jpg') is true;
end $$;

-- Nouvel envoi du MÊME nom (upsert Storage) : repart de zéro, y compris depuis validated/rejected,
-- et c'est le seul chemin autorisé pour revenir à pending.
do $$
begin
  insert into storage.objects (bucket_id, name, metadata)
  values ('chat-files', 'sm/validated.jpg', '{"mimetype":"image/png","size":55}')
  on conflict (bucket_id, name) do update set metadata = excluded.metadata;

  assert (select status from public.storage_upload_validations where object_name = 'sm/validated.jpg') = 'pending',
    're-upload of a validated name must restart as pending';
  -- Le remplacement passe par ON CONFLICT DO UPDATE : seul le trigger AFTER UPDATE peut déclencher la
  -- validation automatique (retry_attempts 0 posé par la garde, puis 1 par le dispatch).
  assert (select retry_attempts from public.storage_upload_validations where object_name = 'sm/validated.jpg') = 1,
    'a replacement must dispatch the validation webhook exactly once';
  assert (select declared_mime from public.storage_upload_validations where object_name = 'sm/validated.jpg') = 'image/png';
  assert (select validated_at from public.storage_upload_validations where object_name = 'sm/validated.jpg') is null;

  insert into storage.objects (bucket_id, name, metadata)
  values ('chat-files', 'sm/rejected.jpg', '{"mimetype":"image/jpeg","size":41}')
  on conflict (bucket_id, name) do update set metadata = excluded.metadata;

  assert (select status from public.storage_upload_validations where object_name = 'sm/rejected.jpg') = 'pending';
  assert (select deleted_at from public.storage_upload_validations where object_name = 'sm/rejected.jpg') is null;
  assert (select delete_attempts from public.storage_upload_validations where object_name = 'sm/rejected.jpg') = 0;

  assert (select retry_attempts from public.storage_upload_validations where object_name = 'sm/rejected.jpg') = 1,
    'a replacement of a rejected name must dispatch the validation webhook exactly once';

  -- Une mise à jour qui ne change ni version ni métadonnées ne déclenche rien et ne touche aucun état.
  update storage.objects set updated_at = now() where bucket_id = 'chat-files' and name = 'sm/pending.jpg';
  assert (select retry_attempts from public.storage_upload_validations where object_name = 'sm/pending.jpg') = 1,
    'a no-op update must not dispatch';

  -- Le drapeau de ré-envoi est retombé : un renversement direct reste interdit.
  assert coalesce(current_setting('kaza.f05_reupload', true), '') <> 'on', 're-upload flag must be reset';
end $$;

rollback;
