-- Assertions SQL de la garde F05 : métadonnées PROVISOIRES (contrôle de permission de Storage)
-- et DÉFINITIVES (insertion réelle). CI jetable uniquement, base locale ACTIVÉE (local-test).
--   psql -v ON_ERROR_STOP=1 -f supabase/activation/ci/guard_assertions.sql
-- Tout est annulé en fin de script. Une insertion définitive réussie se reconnaît à la ligne
-- d'état pending ET à retry_attempts = 1 (le trigger webhook a bien tenté un envoi) ; une
-- insertion provisoire ne crée aucune ligne d'état et ne déclenche aucun envoi.
begin;

create function pg_temp.ins(p_bucket text, p_name text, p_meta text)
returns void language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, metadata) values (p_bucket, p_name, p_meta::jsonb);
end $$;

create function pg_temp.refused(p_bucket text, p_name text, p_meta text, p_label text)
returns void language plpgsql as $$
begin
  begin
    perform pg_temp.ins(p_bucket, p_name, p_meta);
  exception when check_violation then
    return;
  end;
  raise exception 'ASSERTION FAILED (insert must be refused with check_violation): %', p_label;
end $$;

create function pg_temp.provisional_ok(p_bucket text, p_name text, p_meta text, p_label text)
returns void language plpgsql as $$
begin
  perform pg_temp.ins(p_bucket, p_name, p_meta);
  if exists (select 1 from public.storage_upload_validations where bucket_id = p_bucket and object_name = p_name) then
    raise exception 'ASSERTION FAILED (provisional check must not create a validation state): %', p_label;
  end if;
end $$;

create function pg_temp.final_ok(p_bucket text, p_name text, p_meta text, p_label text)
returns void language plpgsql as $$
declare r record;
begin
  perform pg_temp.ins(p_bucket, p_name, p_meta);
  select * into r from public.storage_upload_validations where bucket_id = p_bucket and object_name = p_name;
  if r.status is distinct from 'pending' then
    raise exception 'ASSERTION FAILED (final insert must create a pending state): %', p_label;
  end if;
  if r.retry_attempts <> 1 then
    raise exception 'ASSERTION FAILED (final insert must dispatch the webhook once, retry_attempts=%): %', r.retry_attempts, p_label;
  end if;
end $$;

-- ---------- Contrôle de permission PROVISOIRE ----------
select pg_temp.provisional_ok('chat-files', 'g/prov-mime-only.jpg', '{"mimetype":"image/jpeg"}', 'provisional: mimetype only');
select pg_temp.provisional_ok('chat-files', 'g/prov-len.jpg', '{"mimetype":"image/jpeg","contentLength":40}', 'provisional: contentLength number');
select pg_temp.provisional_ok('chat-files', 'g/prov-len-str.jpg', '{"mimetype":"image/jpeg","contentLength":"40"}', 'provisional: contentLength string');
select pg_temp.provisional_ok('chat-files', 'g/prov-pdf.pdf', '{"mimetype":"application/pdf","contentLength":40}', 'provisional: pdf allowed in chat-files');
select pg_temp.provisional_ok('residence-photos', 'g/prov-ph.jpg', '{"mimetype":"image/webp","contentLength":12}', 'provisional: min length');
select pg_temp.provisional_ok('chat-files', 'g/prov-max.jpg', '{"mimetype":"image/png","contentLength":5242880}', 'provisional: max length');

-- Le MIME est toujours refusé, y compris pendant le contrôle provisoire.
select pg_temp.refused('chat-files', 'g/prov-gif.gif', '{"mimetype":"image/gif"}', 'provisional: gif refused');
select pg_temp.refused('chat-files', 'g/prov-gif2.gif', '{"mimetype":"image/gif","contentLength":40}', 'provisional: gif with length refused');
select pg_temp.refused('residence-photos', 'g/prov-pdf.pdf', '{"mimetype":"application/pdf"}', 'provisional: pdf in residence-photos refused');
select pg_temp.refused('residence-photos', 'g/prov-pdf2.pdf', '{"mimetype":"application/pdf","contentLength":40}', 'provisional: pdf (with length) in residence-photos refused');
select pg_temp.refused('chat-files', 'g/prov-nomime.jpg', '{"contentLength":40}', 'provisional: missing mimetype refused');
select pg_temp.refused('chat-files', 'g/prov-emptymeta.jpg', '{}', 'provisional: empty metadata refused');

-- contentLength fourni => numérique et dans les bornes.
select pg_temp.refused('chat-files', 'g/len-abc.jpg', '{"mimetype":"image/jpeg","contentLength":"abc"}', 'contentLength non numeric');
select pg_temp.refused('chat-files', 'g/len-neg.jpg', '{"mimetype":"image/jpeg","contentLength":"-5"}', 'contentLength negative');
select pg_temp.refused('chat-files', 'g/len-dec.jpg', '{"mimetype":"image/jpeg","contentLength":"40.5"}', 'contentLength decimal');
select pg_temp.refused('chat-files', 'g/len-exp.jpg', '{"mimetype":"image/jpeg","contentLength":"1e3"}', 'contentLength exponent');
select pg_temp.refused('chat-files', 'g/len-huge.jpg', '{"mimetype":"image/jpeg","contentLength":"99999999999999999999999"}', 'contentLength overflow');
select pg_temp.refused('chat-files', 'g/len-small.jpg', '{"mimetype":"image/jpeg","contentLength":11}', 'contentLength too small');
-- Brut : contentLength = taille. Multipart : contentLength = taille + surcoût des parties.
-- Un fichier de 5 MiB exactement envoyé en multipart dépasse donc 5 MiB au contrôle provisoire.
select pg_temp.provisional_ok('chat-files', 'g/len-multipart-max.jpg', '{"mimetype":"image/jpeg","contentLength":5243200}', 'provisional: multipart request of a 5 MiB file (overhead tolerated)');
select pg_temp.provisional_ok('chat-files', 'g/len-overhead-edge.jpg', '{"mimetype":"image/jpeg","contentLength":5308416}', 'provisional: 5 MiB + 64 KiB');
select pg_temp.refused('chat-files', 'g/len-big.jpg', '{"mimetype":"image/jpeg","contentLength":5308417}', 'contentLength beyond 5 MiB + overhead allowance');
select pg_temp.provisional_ok('chat-files', 'g/len-small-multipart.jpg', '{"mimetype":"image/jpeg","contentLength":160}', 'provisional: multipart request of a tiny file');
select pg_temp.refused('chat-files', 'g/len-null.jpg', '{"mimetype":"image/jpeg","contentLength":null}', 'contentLength json null');

-- Sans size ni contentLength, seul le contrôle strictement provisoire (MIME seul) est toléré.
select pg_temp.refused('chat-files', 'g/other-keys.jpg', '{"mimetype":"image/jpeg","cacheControl":"3600"}', 'no size and extra keys refused');

-- ---------- Insertion DÉFINITIVE ----------
select pg_temp.final_ok('chat-files', 'g/final-ok.jpg', '{"mimetype":"image/jpeg","size":40}', 'final: valid');
select pg_temp.final_ok('chat-files', 'g/final-str.jpg', '{"mimetype":"image/jpeg","size":"40"}', 'final: size as string');
select pg_temp.final_ok('chat-files', 'g/final-pdf.pdf', '{"mimetype":"application/pdf","size":40}', 'final: pdf in chat-files');
select pg_temp.final_ok('residence-photos', 'g/final-min.jpg', '{"mimetype":"image/jpeg","size":12}', 'final: min size');
-- Taille réelle exacte : la limite de 5 MiB s'applique SANS marge, quel que soit contentLength.
select pg_temp.final_ok('chat-files', 'g/final-multipart-max.jpg', '{"mimetype":"image/jpeg","size":5242880,"contentLength":5243200}', 'final: 5 MiB file uploaded as multipart');
select pg_temp.refused('chat-files', 'g/final-multipart-over.jpg', '{"mimetype":"image/jpeg","size":5242881,"contentLength":5243200}', 'final: 5 MiB + 1 byte refused despite multipart overhead');
select pg_temp.refused('chat-files', 'g/final-raw-over.jpg', '{"mimetype":"image/jpeg","size":5242881,"contentLength":5242881}', 'final: raw upload of 5 MiB + 1 byte refused');
select pg_temp.final_ok('residence-photos', 'g/final-max.jpg', '{"mimetype":"image/webp","size":5242880}', 'final: max size');
-- size fait foi : contentLength invalide ou différent est ignoré quand size est valide.
select pg_temp.final_ok('chat-files', 'g/final-ignorelen.jpg', '{"mimetype":"image/jpeg","size":40,"contentLength":"abc"}', 'final: size wins over bad contentLength');

select pg_temp.refused('chat-files', 'g/final-nosize-keys.jpg', '{"mimetype":"image/jpeg","eTag":"x"}', 'final-like without size refused');
select pg_temp.refused('chat-files', 'g/final-abc.jpg', '{"mimetype":"image/jpeg","size":"abc"}', 'size non numeric');
select pg_temp.refused('chat-files', 'g/final-neg.jpg', '{"mimetype":"image/jpeg","size":"-40"}', 'size negative');
select pg_temp.refused('chat-files', 'g/final-dec.jpg', '{"mimetype":"image/jpeg","size":"40.5"}', 'size decimal');
select pg_temp.refused('chat-files', 'g/final-exp.jpg', '{"mimetype":"image/jpeg","size":"1e3"}', 'size exponent');
select pg_temp.refused('chat-files', 'g/final-empty.jpg', '{"mimetype":"image/jpeg","size":""}', 'size empty');
select pg_temp.refused('chat-files', 'g/final-huge.jpg', '{"mimetype":"image/jpeg","size":"99999999999999999999999"}', 'size overflow');
select pg_temp.refused('chat-files', 'g/final-nullsize.jpg', '{"mimetype":"image/jpeg","size":null}', 'size json null');
select pg_temp.refused('chat-files', 'g/final-small.jpg', '{"mimetype":"image/jpeg","size":11}', 'size 11 refused');
select pg_temp.refused('chat-files', 'g/final-big.jpg', '{"mimetype":"image/jpeg","size":5242881}', 'size above 5 MiB');
-- contentLength valide ne rattrape JAMAIS un size invalide.
select pg_temp.refused('chat-files', 'g/final-len-no-rescue.jpg', '{"mimetype":"image/jpeg","size":5,"contentLength":1000}', 'valid contentLength must not rescue invalid size');
select pg_temp.refused('chat-files', 'g/final-len-no-rescue2.jpg', '{"mimetype":"image/jpeg","size":"abc","contentLength":1000}', 'valid contentLength must not rescue malformed size');
select pg_temp.refused('chat-files', 'g/final-len-no-rescue3.jpg', '{"mimetype":"image/jpeg","size":5242881,"contentLength":40}', 'small contentLength must not hide a huge size');

-- MIME refusés en insertion définitive.
select pg_temp.refused('residence-photos', 'g/final-pdf.pdf', '{"mimetype":"application/pdf","size":40}', 'final: pdf in residence-photos refused');
select pg_temp.refused('chat-files', 'g/final-gif.gif', '{"mimetype":"image/gif","size":40}', 'final: gif refused');
select pg_temp.refused('chat-files', 'g/final-nomime.jpg', '{"size":40}', 'final: missing mimetype refused');

-- Un autre bucket n'est pas concerné par la garde.
select pg_temp.ins('receipts', 'g/other-bucket.bin', '{"mimetype":"application/octet-stream"}')
 where exists (select 1 from storage.buckets where id = 'receipts');

-- Les deux dernières insertions refusées ne laissent aucune ligne d'état.
do $$
begin
  assert not exists (select 1 from public.storage_upload_validations where object_name like 'g/%' and object_name ~ '(abc|neg|dec|exp|empty|huge|small|big|nullsize|no-rescue|gif|nomime|nosize)'),
    'refused inserts must leave no validation state';
  assert (select count(*) from public.storage_upload_validations where object_name like 'g/final-%'
            and status = 'pending') = 7, 'exactly the 7 valid final inserts must be pending';
  assert (select count(*) from public.storage_upload_validations where object_name like 'g/prov-%') = 0,
    'provisional checks must leave no validation state';
end $$;

rollback;
