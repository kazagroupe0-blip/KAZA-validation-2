-- Assertions SQL : idempotence du dispatch webhook (une tentative par GÉNÉRATION de contenu),
-- remplacement, reprise, mise en file pg_net en échec, génération obsolète. CI jetable uniquement,
-- base locale ACTIVÉE (local-test). Tout est annulé en fin de script.
--   psql -v ON_ERROR_STOP=1 -f supabase/activation/ci/idempotence_assertions.sql
-- Les requêtes pg_net émises dans cette transaction ne partent jamais (rollback).
begin;

create function pg_temp.st(p_name text)
returns public.storage_upload_validations language sql as $$
  select v from public.storage_upload_validations v where v.bucket_id = 'chat-files' and v.object_name = p_name
$$;

-- 1) Nouvel upload : état pending, génération = version, UN envoi revendiqué et mis en file.
insert into storage.objects (bucket_id, name, version, metadata)
values ('chat-files', 'idem/a.jpg', 'ver-1', '{"mimetype":"image/jpeg","size":40,"eTag":"e1"}');

do $$
declare r public.storage_upload_validations;
begin
  r := pg_temp.st('idem/a.jpg');
  assert r.status = 'pending', 'new upload must be pending';
  assert r.generation = 'ver-1', format('generation expected ver-1, got %s', r.generation);
  assert r.dispatched_generation = 'ver-1', 'the dispatch must be claimed for the generation';
  assert r.retry_attempts = 1, format('exactly one attempt expected, got %s', r.retry_attempts);
  assert r.last_request_id is not null, 'a request really enqueued must record its pg_net id';
end $$;

-- 2) Événements redondants de la MÊME génération : aucune tentative consommée, aucun nouvel envoi.
--    (eTag puis taille changent, la version reste : le trigger UPDATE s'évalue mais le dispatch sort.)
create temp table idem_before as select last_request_id, retry_attempts from public.storage_upload_validations
 where bucket_id = 'chat-files' and object_name = 'idem/a.jpg';

update storage.objects set metadata = metadata || '{"eTag":"e2"}'
 where bucket_id = 'chat-files' and name = 'idem/a.jpg';
update storage.objects set metadata = metadata || '{"size":41}'
 where bucket_id = 'chat-files' and name = 'idem/a.jpg';

do $$
declare r public.storage_upload_validations; b record;
begin
  select * into b from idem_before;
  r := pg_temp.st('idem/a.jpg');
  assert r.retry_attempts = b.retry_attempts, 'duplicate events of one generation must not consume an attempt';
  assert r.last_request_id is not distinct from b.last_request_id, 'duplicate events must not enqueue a request';
  assert r.status = 'pending';
end $$;

-- 3) Mise à jour ordinaire de métadonnées (ni version, ni eTag, ni taille) : aucun dispatch.
update storage.objects set metadata = metadata || '{"cacheControl":"max-age=3600"}'
 where bucket_id = 'chat-files' and name = 'idem/a.jpg';

do $$
declare r public.storage_upload_validations; b record;
begin
  select * into b from idem_before;
  r := pg_temp.st('idem/a.jpg');
  assert r.retry_attempts = b.retry_attempts and r.last_request_id is not distinct from b.last_request_id,
    'a metadata-only update must not dispatch';
end $$;

-- 4) Reprise après délai : vraie tentative (non soumise à la revendication), nouvelle requête.
--    Une requête mise en file sans réponse (Edge non terminé) reste récupérable.
do $$
declare r public.storage_upload_validations; v_old bigint; n integer;
begin
  r := pg_temp.st('idem/a.jpg');
  v_old := r.last_request_id;
  assert not exists (select 1 from net._http_response where id = v_old), 'no response yet: request unfinished';

  update public.storage_upload_validations set last_attempt_at = now() - interval '10 minutes'
   where bucket_id = 'chat-files' and object_name = 'idem/a.jpg';
  n := private.retry_stale_storage_validations();
  assert n >= 1, 'the unfinished validation must be sent again';

  r := pg_temp.st('idem/a.jpg');
  assert r.retry_attempts = 2, format('a real retry consumes one attempt, got %s', r.retry_attempts);
  assert r.last_request_id is not null and r.last_request_id > v_old, 'the retry must record its own request id';
  assert r.status = 'pending';

  -- Pas de nouvel envoi avant le délai.
  n := private.retry_stale_storage_validations();
  assert (pg_temp.st('idem/a.jpg')).retry_attempts = 2, 'no retry before the delay';
end $$;

-- 5) Remplacement RÉEL (nouvelle version) d'un objet validé : nouvelle génération, pending, un envoi.
update public.storage_upload_validations
   set status = 'validated', validated_at = now(), detected_mime = 'image/jpeg'
 where bucket_id = 'chat-files' and object_name = 'idem/a.jpg' and status = 'pending';

create temp table idem_prev as select last_request_id from public.storage_upload_validations
 where bucket_id = 'chat-files' and object_name = 'idem/a.jpg';

insert into storage.objects (bucket_id, name, version, metadata)
values ('chat-files', 'idem/a.jpg', 'ver-2', '{"mimetype":"image/png","size":60,"eTag":"e9"}')
on conflict (bucket_id, name) do update
  set version = excluded.version, metadata = excluded.metadata;

do $$
declare r public.storage_upload_validations; p record;
begin
  select * into p from idem_prev;
  r := pg_temp.st('idem/a.jpg');
  assert r.status = 'pending', 'a replacement restarts as pending';
  assert r.generation = 'ver-2', format('new generation expected, got %s', r.generation);
  assert r.dispatched_generation = 'ver-2';
  assert r.retry_attempts = 1, 'a replacement is validated once, as a new object';
  assert r.last_request_id is not null and r.last_request_id > p.last_request_id, 'a new request must be enqueued';
  assert r.validated_at is null and r.detected_mime is null;
end $$;

-- 6) Génération obsolète : le verdict d'un ancien contenu n'écrit rien sur le nouveau contenu.
do $$
declare n integer;
begin
  update public.storage_upload_validations
     set status = 'validated', validated_at = now()
   where bucket_id = 'chat-files' and object_name = 'idem/a.jpg'
     and status = 'pending' and generation = 'ver-1';
  get diagnostics n = row_count;
  assert n = 0, 'a verdict for generation ver-1 must not validate generation ver-2';

  update public.storage_upload_validations
     set status = 'rejected', rejection_reason = 'stale'
   where bucket_id = 'chat-files' and object_name = 'idem/a.jpg'
     and status = 'pending' and generation = 'ver-1';
  get diagnostics n = row_count;
  assert n = 0, 'a stale rejection must not reject generation ver-2';

  update public.storage_upload_validations
     set status = 'validated', validated_at = now()
   where bucket_id = 'chat-files' and object_name = 'idem/a.jpg'
     and status = 'pending' and generation = 'ver-2';
  get diagnostics n = row_count;
  assert n = 1, 'the verdict for the current generation applies';
end $$;

-- 7) La génération ne change que par un nouvel envoi.
do $$
begin
  begin
    update public.storage_upload_validations set generation = 'forged'
     where bucket_id = 'chat-files' and object_name = 'idem/a.jpg';
    raise exception 'ASSERTION FAILED: generation changed outside a new upload';
  exception when check_violation then
    null;
  end;
end $$;

rollback;
