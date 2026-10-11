-- KAZA F05 — PHASE 1 : schéma, fonctions et état de validation.
-- Cette migration est rejouable (supabase db reset, CI) et ne dépend d'aucune valeur
-- d'environnement : elle ne crée AUCUN trigger, AUCUNE tâche cron et ne modifie
-- AUCUNE politique Storage. Les triggers existants (guard_storage_upload,
-- protect_objects_delete, update_objects_updated_at, et le webhook legacy éventuel)
-- et les politiques de lecture restent inchangés.
-- L'activation (PHASE 2) est dans supabase/activation/f05_activate_storage_validation.sql,
-- volontairement hors de supabase/migrations/.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to anon, authenticated, service_role;

-- Cible du webhook, lue dans Vault PAR ENVIRONNEMENT (aucune valeur codée ici).
-- Trois entrées Vault doivent être préparées séparément dans chaque projet :
--   kaza_storage_validation_webhook_secret      (>= 32 caractères, différent par projet)
--   kaza_storage_validation_function_url        (https://<ref>.supabase.co/functions/v1/validate-file-upload[-v2])
--   kaza_storage_validation_expected_project_ref (<ref> attendu : double saisie vérifiable)
-- Le SQL ne peut pas connaître de façon fiable le project ref de sa propre base :
-- cette vérification détecte une URL copiée d'un autre projet, mais pas une
-- erreur commise à l'identique sur l'URL ET sur la référence attendue.
create or replace function private.storage_validation_target(
  out o_url text,
  out o_secret text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_expected_ref text;
  v_url_ref text;
begin
  if to_regnamespace('vault') is null then
    raise exception 'Storage validation prerequisite missing: vault schema';
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into o_secret using 'kaza_storage_validation_webhook_secret';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into o_url using 'kaza_storage_validation_function_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_expected_ref using 'kaza_storage_validation_expected_project_ref';

  if o_secret is null or length(o_secret) < 32 then
    raise exception 'Storage validation webhook secret missing or invalid (Vault: kaza_storage_validation_webhook_secret)';
  end if;

  if v_expected_ref is null or v_expected_ref !~ '^[a-z0-9]{20}$' then
    raise exception 'Storage validation expected project ref missing or invalid (Vault: kaza_storage_validation_expected_project_ref)';
  end if;

  v_url_ref := substring(
    o_url from '^https://([a-z0-9]{20})\.supabase\.co/functions/v1/validate-file-upload(?:-v2)?$'
  );

  if o_url is null or v_url_ref is null then
    raise exception 'Storage validation function URL missing or malformed (Vault: kaza_storage_validation_function_url)';
  end if;

  if v_url_ref <> v_expected_ref then
    raise exception 'Storage validation function URL targets a different project than the expected project ref';
  end if;
end;
$function$;

revoke all on function private.storage_validation_target()
  from public, anon, authenticated, service_role;


create table if not exists public.storage_upload_validations (
  bucket_id text not null
    check (bucket_id in ('residence-photos', 'chat-files')),
  object_name text not null,
  status text not null
    check (status in ('pending', 'validated', 'rejected')),
  declared_mime text,
  detected_mime text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  validated_at timestamptz,
  primary key (bucket_id, object_name),
  check (
    (status = 'validated' and validated_at is not null)
    or (status <> 'validated' and validated_at is null)
  )
);

alter table public.storage_upload_validations
  add column if not exists retry_attempts integer not null default 0;

alter table public.storage_upload_validations
  add column if not exists last_attempt_at timestamptz;

alter table public.storage_upload_validations
  add column if not exists last_error text;

do $constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.storage_upload_validations'::regclass
      and conname = 'storage_upload_validations_retry_attempts_check'
  ) then
    alter table public.storage_upload_validations
      add constraint storage_upload_validations_retry_attempts_check
      check (retry_attempts between 0 and 5);
  end if;
end;
$constraint$;

create index if not exists storage_upload_validations_pending_retry_idx
  on public.storage_upload_validations (status, last_attempt_at, created_at)
  where status = 'pending';

alter table public.storage_upload_validations enable row level security;

revoke all on table public.storage_upload_validations
  from public, anon, authenticated;

grant select on table public.storage_upload_validations to authenticated;
grant all on table public.storage_upload_validations to service_role;

drop policy if exists storage_upload_validations_read_own
  on public.storage_upload_validations;

create policy storage_upload_validations_read_own
on public.storage_upload_validations
for select
to authenticated
using (
  (
    bucket_id = 'chat-files'
    and split_part(object_name, '/', 1) = (select auth.uid()::text)
  )
  or (
    bucket_id = 'residence-photos'
    and (
      split_part(object_name, '/', 1) = (select auth.uid()::text)
      or (
        split_part(object_name, '/', 1) = 'residences'
        and split_part(object_name, '/', 2) = (select auth.uid()::text)
      )
    )
  )
);

-- This SECURITY DEFINER helper avoids the validation table's owner-only RLS
-- hiding a pending row from a different user who requests a shared object.
-- A missing row is a historical object during this staged rollout; it is
-- NOT proof that the historical file has been validated.
create or replace function private.storage_upload_validation_allows_read(
  p_bucket text,
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    not exists (
      select 1
      from public.storage_upload_validations v
      where v.bucket_id = p_bucket
        and v.object_name = p_object_name
    )
    or exists (
      select 1
      from public.storage_upload_validations v
      where v.bucket_id = p_bucket
        and v.object_name = p_object_name
        and v.status = 'validated'
    );
$$;

revoke all on function
  private.storage_upload_validation_allows_read(text, text)
  from public, anon, authenticated;

grant execute on function
  private.storage_upload_validation_allows_read(text, text)
  to anon, authenticated, service_role;

-- Harden the search path of the existing MIME predicate.
create or replace function public._allowed_upload_mime(p_mime text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_mime in (
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  );
$function$;


-- Version F05 de la garde d'upload (rejet synchrone MIME/taille + création de l'état
-- pending dans la même transaction). Elle n'est PAS attachée par cette migration :
-- l'ancienne garde public._guard_storage_upload() reste liée à guard_storage_upload
-- jusqu'à l'activation contrôlée (supabase/activation/).
create or replace function public._guard_storage_upload_f05()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := NEW.bucket_id;
  v_mime text;
  v_size_text text;
  v_size bigint;
begin
  if v_bucket is null
     or v_bucket not in ('residence-photos', 'chat-files') then
    return NEW;
  end if;

  v_mime := lower(btrim(coalesce(NEW.metadata->>'mimetype', '')));
  v_size_text := NEW.metadata->>'size';

  if v_mime = '' then
    raise exception 'Upload rejected: MIME metadata is required'
      using errcode = 'check_violation';
  end if;

  -- residence-photos : images uniquement ; chat-files : images + PDF.
  if not public._allowed_upload_mime(v_mime)
     or (v_bucket = 'residence-photos' and v_mime = 'application/pdf') then
    raise exception 'Upload rejected: MIME type is not allowed'
      using errcode = 'check_violation';
  end if;

  -- La longueur est bornée avant le cast pour éviter tout dépassement bigint.
  if v_size_text is null
     or v_size_text !~ '^[0-9]+$'
     or length(v_size_text) > 12 then
    raise exception 'Upload rejected: valid size metadata is required'
      using errcode = 'check_violation';
  end if;

  v_size := v_size_text::bigint;

  if v_size < 12 then
    raise exception 'Upload rejected: file is too small'
      using errcode = 'check_violation';
  end if;

  if v_size > 20 * 1024 * 1024 then
    raise exception 'Upload rejected: file is too large'
      using errcode = 'check_violation';
  end if;

  insert into public.storage_upload_validations (
    bucket_id, object_name, status, declared_mime, byte_size,
    rejection_reason, validated_at, created_at, updated_at
  )
  values (
    v_bucket, NEW.name, 'pending', v_mime, v_size,
    null, null, now(), now()
  )
  on conflict (bucket_id, object_name) do update
  set status = 'pending',
      declared_mime = excluded.declared_mime,
      detected_mime = null,
      byte_size = excluded.byte_size,
      rejection_reason = null,
      validated_at = null,
       retry_attempts = 0,
      last_attempt_at = null,
      last_error = null,
      updated_at = now();

  return NEW;
end;
$$;


-- Le webhook ne stocke aucun jeton privilégié dans ses arguments.
-- Le secret dédié et l'URL sont lus depuis Vault au moment de l'appel.
create or replace function private.dispatch_storage_validation_webhook()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_url text;
  v_secret text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Unexpected storage validation event: %', tg_op;
  end if;

  if new.bucket_id is null
     or new.bucket_id not in ('residence-photos', 'chat-files') then
    return new;
  end if;

  select t.o_url, t.o_secret
    into v_url, v_secret
    from private.storage_validation_target() as t;

  update public.storage_upload_validations
     set retry_attempts = least(retry_attempts + 1, 5),
         last_attempt_at = clock_timestamp(),
         last_error = null,
         updated_at = clock_timestamp()
   where bucket_id = new.bucket_id
     and object_name = new.name
     and status = 'pending';

  if not found then
    raise exception 'Storage validation state missing for new object';
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object(
      'type', tg_op,
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new),
      'old_record', null
    ),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-storage-validation-secret', v_secret
    ),
    timeout_milliseconds := 10000
  );

  return new;
end;
$function$;

create or replace function private.retry_stale_storage_validations()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $retry$
declare
  v_url text;
  v_secret text;
  r record;
  v_queued integer := 0;
  v_job_id bigint;
begin
  select t.o_url, t.o_secret
    into v_url, v_secret
    from private.storage_validation_target() as t;

  -- Les objets supprimés hors du processus normal ne doivent pas rester
  -- indéfiniment en attente.
  update public.storage_upload_validations v
     set status = 'rejected',
         rejection_reason = 'Storage object missing during validation retry',
         validated_at = null,
         updated_at = clock_timestamp()
   where v.status = 'pending'
     and coalesce(v.last_attempt_at, v.created_at)
           < clock_timestamp() - interval '5 minutes'
     and not exists (
       select 1
         from storage.objects o
        where o.bucket_id = v.bucket_id
          and o.name = v.object_name
     );

  -- Après cinq envois, arrêter les relances automatiques.
  update public.storage_upload_validations v
     set status = 'rejected',
         rejection_reason = 'Automatic validation retry limit exceeded; manual review required',
         validated_at = null,
         updated_at = clock_timestamp()
   where v.status = 'pending'
     and v.retry_attempts >= 5
     and coalesce(v.last_attempt_at, v.created_at)
           < clock_timestamp() - interval '5 minutes'
     and exists (
       select 1
         from storage.objects o
        where o.bucket_id = v.bucket_id
          and o.name = v.object_name
     );

  for r in
    select
      v.bucket_id,
      v.object_name,
      to_jsonb(o) as object_payload
    from public.storage_upload_validations v
    join storage.objects o
      on o.bucket_id = v.bucket_id
     and o.name = v.object_name
    where v.status = 'pending'
      and v.retry_attempts < 5
      and coalesce(v.last_attempt_at, v.created_at)
            < clock_timestamp() - interval '5 minutes'
    order by coalesce(v.last_attempt_at, v.created_at)
    limit 50
    for update of v skip locked
  loop
    update public.storage_upload_validations
       set retry_attempts = retry_attempts + 1,
           last_attempt_at = clock_timestamp(),
           last_error = null,
           updated_at = clock_timestamp()
     where bucket_id = r.bucket_id
       and object_name = r.object_name
       and status = 'pending'
       and retry_attempts < 5;

    if not found then
      continue;
    end if;

    begin
      perform net.http_post(
        url := v_url,
        body := jsonb_build_object(
          'type', 'INSERT',
          'table', 'objects',
          'schema', 'storage',
          'record', r.object_payload,
          'old_record', null
        ),
        params := '{}'::jsonb,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-storage-validation-secret', v_secret
        ),
        timeout_milliseconds := 10000
      );

      v_queued := v_queued + 1;
    exception when others then
      update public.storage_upload_validations
         set last_error = left(SQLERRM, 500),
             updated_at = clock_timestamp()
       where bucket_id = r.bucket_id
         and object_name = r.object_name
         and status = 'pending';

      raise warning 'Storage validation retry enqueue failed for bucket %, object %',
        r.bucket_id, r.object_name;
    end;
  end loop;

  return v_queued;
end;
$retry$;

revoke all on function private.retry_stale_storage_validations()
  from public, anon, authenticated, service_role;

revoke all on function private.dispatch_storage_validation_webhook()
  from public, anon, authenticated;
