-- KAZA F05 — PHASE 2 : ACTIVATION CONTRÔLÉE (hors supabase/migrations, jamais rejouée par db reset).
--
-- Usage (psql, une base à la fois, par un opérateur) :
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v target_env=<production|test|local-test> -v expected_ref=<ref> \n--        -f supabase/activation/f05_activate_storage_validation.sql
--
-- Prérequis : migration 20261010175125 appliquée, fonction Edge déployée et vérifiée avec
-- supabase/activation/preflight-edge.sh, entrées Vault créées (voir docs/audits).
-- Tout est exécuté dans UNE transaction : si un contrôle échoue, rien n'est installé.
-- Le trigger legacy du projet de test est remplacé dans cette même transaction (pas de trou).
-- Les triggers protect_objects_delete et update_objects_updated_at ne sont pas touchés.

\set ON_ERROR_STOP on
begin;

select set_config('kaza.f05_target_env', :'target_env', true),
       set_config('kaza.f05_expected_ref', :'expected_ref', true);

do $check$
declare
  v_env text := current_setting('kaza.f05_target_env', true);
  v_ref text := current_setting('kaza.f05_expected_ref', true);
  v_vault_ref text;
  v_required_ref text;
  v_fn text;
begin
  -- Le project ref n'est pas déductible du SQL : il est affirmé par l'opérateur ET doit
  -- correspondre à l'environnement ET à l'entrée Vault ET à l'URL. Le ref de test n'est
  -- jamais accepté pour la production, et inversement.
  v_required_ref := case v_env
    when 'production' then 'qbogbuwnkwqgarbchtyr'
    when 'test' then 'bzvlnefowgtuasqjfpem'
    when 'local-test' then 'localtestrefaaaaaaaa'
    else null
  end;

  if v_required_ref is null then
    raise exception 'F05 activation: target_env must be production, test or local-test';
  end if;

  if v_ref is distinct from v_required_ref then
    raise exception 'F05 activation: expected_ref does not match target_env %', v_env;
  end if;

  if to_regclass('public.storage_upload_validations') is null then
    raise exception 'F05 activation: phase 1 migration not applied (table missing)';
  end if;

  foreach v_fn in array array[
    'private.storage_validation_target()',
    'private.dispatch_storage_validation_webhook()',
    'private.retry_stale_storage_validations()',
    'private.storage_upload_validation_allows_read(text,text)',
    'public._guard_storage_upload_f05()',
    'public._guard_storage_upload()'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'F05 activation: missing function %', v_fn;
    end if;
  end loop;

  if to_regclass('cron.job') is null then
    raise exception 'F05 activation: pg_cron is required';
  end if;

  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'F05 activation: pg_net (net.http_post) is required';
  end if;

  if (select count(*) from storage.buckets
       where id in ('residence-photos', 'chat-files')) <> 2 then
    raise exception 'F05 activation: expected storage buckets are missing';
  end if;

  -- Valide secret (>= 32), URL (forme + ref de l'URL = ref attendu en Vault).
  perform private.storage_validation_target();

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_vault_ref using 'kaza_storage_validation_expected_project_ref';

  if v_vault_ref is distinct from v_ref then
    raise exception 'F05 activation: Vault expected project ref differs from the expected_ref argument';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'storage.objects'::regclass and tgname = 'protect_objects_delete'
  ) then
    raise warning 'F05 activation: trigger protect_objects_delete not found on storage.objects (not modified by this script)';
  end if;
end;
$check$;

-- 1) Garde d'upload F05 (MIME/taille synchrone + état pending).
drop trigger if exists guard_storage_upload on storage.objects;

create trigger guard_storage_upload
  before insert on storage.objects
  for each row
  execute function public._guard_storage_upload_f05();

-- 2) Webhook dédié (remplace le webhook legacy et son Authorization en clair).
drop trigger if exists "kaza-storage-content-validation" on storage.objects;

create trigger "kaza-storage-content-validation"
  after insert on storage.objects
  for each row
  when (new.bucket_id in ('residence-photos', 'chat-files'))
  execute function private.dispatch_storage_validation_webhook();

do $cron$
declare
  v_job_id bigint;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is required for automatic storage validation recovery';
  end if;

  for v_job_id in
    execute 'select jobid from cron.job where jobname = $1'
      using 'storage-validation-retry-every-minute'
  loop
    execute 'select cron.unschedule($1)' using v_job_id;
  end loop;

  execute 'select cron.schedule($1, $2, $3)'
    into v_job_id
    using
      'storage-validation-retry-every-minute',
      '* * * * *',
      'select private.retry_stale_storage_validations();';
end;
$cron$;

-- A new upload cannot be read while pending or rejected. Historical objects
-- without a state row remain temporarily governed by their legacy access rules.
drop policy if exists "residence-photos-read" on storage.objects;

create policy "residence-photos-read"
on storage.objects
for select
to public
using (
  bucket_id = 'residence-photos'
  and private.storage_upload_validation_allows_read(bucket_id, name)
  and (
    owner_id = (select auth.uid()::text)
    or split_part(name, '/', 1) = (select auth.uid()::text)
    or (
      split_part(name, '/', 1) = 'residences'
      and split_part(name, '/', 2) = (select auth.uid()::text)
    )
    or exists (
      select 1
      from public.residences r
      where r.is_published = true
        and r.is_verified = true
        and r.moderation_status = 'approved'
        and r.status = 'libre'
        and exists (
          select 1
          from unnest(coalesce(r.photos, '{}'::text[])) ph
          where case
            when position('/residence-photos/' in ph) > 0
              then split_part(ph, '/residence-photos/', 2)
            when left(ph, length('residence-photos/')) = 'residence-photos/'
              then substr(ph, length('residence-photos/') + 1)
            else ph
          end = objects.name
        )
    )
  )
);

drop policy if exists "chat-files-read" on storage.objects;
drop policy if exists "chat-files-read-owner" on storage.objects;

create policy "chat-files-read-owner"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'chat-files'
  and private.storage_upload_validation_allows_read(bucket_id, name)
  and (
    -- The uploader may read their own object after validation succeeds.
    split_part(name, '/', 1) = (select auth.uid()::text)
    or exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where
        (c.tenant_id = auth.uid() or c.landlord_id = auth.uid())
        and split_part(name, '/', 1) = m.sender_id::text
        and exists (
          select 1
          from unnest(coalesce(m.attachments, '{}'::text[])) as attachment(path)
          where attachment.path = objects.name
        )
    )
  )
);

commit;
