-- KAZA F05 — PHASE 1 : schéma, fonctions et état de validation.
-- Cette migration est rejouable (supabase db reset, CI) et ne dépend d'aucune valeur
-- d'environnement : elle ne crée AUCUN trigger sur storage.objects, AUCUNE tâche cron et ne
-- modifie AUCUNE politique Storage (seul un trigger de transition d'état est posé, sur la
-- table propre public.storage_upload_validations). Les triggers existants (guard_storage_upload,
-- protect_objects_delete, update_objects_updated_at, et le webhook legacy éventuel)
-- et les politiques de lecture restent inchangés.
-- L'activation (PHASE 2) est dans supabase/activation/f05_activate_storage_validation.sql,
-- volontairement hors de supabase/migrations/.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to anon, authenticated, service_role;

-- Enregistrement de l'environnement d'activation réellement choisi (écrit UNIQUEMENT par
-- supabase/activation/f05_activate_storage_validation.sql, supprimé par le rollback).
-- La cible HTTP locale n'est acceptée que si cet enregistrement vaut 'local-test' : elle ne
-- dépend donc pas seulement de trois valeurs Vault modifiables séparément.
-- La cohérence environnement <-> ref réel est vérifiée par le script d'activation.
create table if not exists private.f05_activation (
  singleton boolean primary key default true check (singleton),
  target_env text not null check (target_env in ('production', 'test', 'local-test')),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  activated_at timestamptz not null default now(),
  check (target_env <> 'local-test' or project_ref = 'localtestrefaaaaaaaa')
);

revoke all on table private.f05_activation from public, anon, authenticated, service_role;

-- Cible du webhook, lue dans Vault PAR ENVIRONNEMENT (aucune valeur codée ici).
-- Entrées Vault à préparer séparément dans chaque projet :
--   kaza_storage_validation_webhook_secret       (>= 32 caractères, différent par projet)
--   kaza_storage_validation_function_url         (https://<ref>.supabase.co/functions/v1/validate-file-upload[-v2])
--   kaza_storage_validation_expected_project_ref (<ref> attendu : double saisie vérifiable)
--   kaza_storage_validation_apikey               (OPTIONNEL : clé anon/publishable uniquement)
-- Le SQL ne peut pas connaître de façon fiable le project ref de sa propre base :
-- cette vérification détecte une URL copiée d'un autre projet, mais pas une
-- erreur commise à l'identique sur l'URL ET sur la référence attendue.
-- Une URL http://<hôte>:<port>/functions/v1/... (pile Supabase locale de CI) n'est acceptée
-- que si l'activation enregistrée est 'local-test' ET que le ref attendu est
-- 'localtestrefaaaaaaaa' ; production et test distant la refusent.
-- Le type de retour change (clé apikey en plus) : CREATE OR REPLACE ne peut pas le modifier.
drop function if exists private.storage_validation_target();

create function private.storage_validation_target(
  out o_url text,
  out o_secret text,
  out o_apikey text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_expected_ref text;
  v_url_ref text;
  v_env text;
  v_registered_ref text;
  v_claims jsonb;
  v_payload text;
begin
  if to_regnamespace('vault') is null then
    raise exception 'Storage validation prerequisite missing: vault schema';
  end if;

  select a.target_env, a.project_ref
    into v_env, v_registered_ref
    from private.f05_activation a;

  if v_env is null then
    raise exception 'Storage validation is not activated (no registered activation environment)';
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into o_secret using 'kaza_storage_validation_webhook_secret';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into o_url using 'kaza_storage_validation_function_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_expected_ref using 'kaza_storage_validation_expected_project_ref';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into o_apikey using 'kaza_storage_validation_apikey';

  if o_secret is null or length(o_secret) < 32 then
    raise exception 'Storage validation webhook secret missing or invalid (Vault: kaza_storage_validation_webhook_secret)';
  end if;

  if v_expected_ref is null or v_expected_ref !~ '^[a-z0-9]{20}$' then
    raise exception 'Storage validation expected project ref missing or invalid (Vault: kaza_storage_validation_expected_project_ref)';
  end if;

  if v_expected_ref <> v_registered_ref then
    raise exception 'Storage validation expected project ref differs from the registered activation';
  end if;

  if o_url is null then
    raise exception 'Storage validation function URL missing or malformed (Vault: kaza_storage_validation_function_url)';
  end if;

  v_url_ref := substring(
    o_url from '^https://([a-z0-9]{20})\.supabase\.co/functions/v1/validate-file-upload(?:-v2)?$'
  );

  if v_url_ref is not null then
    if v_url_ref <> v_expected_ref then
      raise exception 'Storage validation function URL targets a different project than the expected project ref';
    end if;
  elsif o_url ~ '^http://[a-z0-9][a-z0-9_.-]{0,62}:[0-9]{2,5}/functions/v1/validate-file-upload(?:-v2)?$' then
    if v_env <> 'local-test' or v_expected_ref <> 'localtestrefaaaaaaaa' then
      raise exception 'Local HTTP function URL is only allowed for the registered local-test environment';
    end if;
  else
    raise exception 'Storage validation function URL missing or malformed (Vault: kaza_storage_validation_function_url)';
  end if;

  -- Clé d'accès de passerelle facultative : uniquement une clé anon / publishable.
  -- Jamais une clé secrète ni un JWT service_role.
  if o_apikey is not null then
    if o_apikey like 'sb\_secret\_%' then
      raise exception 'Storage validation apikey must be an anon/publishable key, not a secret key';
    elsif o_apikey like 'sb\_publishable\_%' then
      null;
    elsif o_apikey ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$' then
      v_payload := translate(split_part(o_apikey, '.', 2), '-_', '+/');
      v_payload := rpad(v_payload, length(v_payload) + ((4 - length(v_payload) % 4) % 4), '=');
      begin
        v_claims := convert_from(decode(v_payload, 'base64'), 'utf8')::jsonb;
      exception when others then
        raise exception 'Storage validation apikey is not a readable JWT';
      end;
      if v_claims->>'role' is distinct from 'anon' then
        raise exception 'Storage validation apikey must carry the anon role';
      end if;
    else
      raise exception 'Storage validation apikey has an unrecognised format';
    end if;
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

-- Suivi de la suppression d'un objet rejeté (reprise des suppressions échouées).
alter table public.storage_upload_validations
  add column if not exists deleted_at timestamptz;

alter table public.storage_upload_validations
  add column if not exists delete_attempts integer not null default 0
  check (delete_attempts between 0 and 5);

-- Idempotence du webhook. `generation` identifie la génération de contenu décrite par la ligne
-- (posée par la garde d'upload à chaque nouvel envoi) ; `dispatched_generation` est la dernière
-- génération pour laquelle un envoi a été revendiqué atomiquement ; `last_request_id` est l'id
-- pg_net de la dernière requête réellement mise en file (NULL = aucun envoi mis en file).
alter table public.storage_upload_validations
  add column if not exists generation text;

alter table public.storage_upload_validations
  add column if not exists dispatched_generation text;

alter table public.storage_upload_validations
  add column if not exists last_request_id bigint;

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

-- Les états terminaux ne se renversent jamais : validated et rejected ne peuvent plus changer
-- de statut. Seul un NOUVEL envoi du même nom (garde d'upload, qui pose le drapeau local à la
-- transaction kaza.f05_reupload) peut repasser la ligne à pending.
create or replace function private.storage_validation_state_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  if new.status is distinct from old.status then
    if old.status = 'pending' and new.status in ('validated', 'rejected') then
      return new;
    end if;
    if new.status = 'pending'
       and coalesce(current_setting('kaza.f05_reupload', true), '') = 'on' then
      return new;
    end if;
    raise exception 'Storage validation state % -> % is not allowed', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'rejected'
     and old.deleted_at is not null
     and new.deleted_at is null
     and coalesce(current_setting('kaza.f05_reupload', true), '') <> 'on' then
    raise exception 'A recorded deletion of a rejected object cannot be undone'
      using errcode = 'check_violation';
  end if;

  if new.generation is distinct from old.generation
     and coalesce(current_setting('kaza.f05_reupload', true), '') <> 'on' then
    raise exception 'The content generation of a validation state cannot change outside a new upload'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists storage_validation_state_guard
  on public.storage_upload_validations;

create trigger storage_validation_state_guard
  before update on public.storage_upload_validations
  for each row
  execute function private.storage_validation_state_guard();

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
-- Clé de génération de contenu d'un objet : sa version Storage si elle existe, sinon eTag|taille.
create or replace function private.f05_object_generation(p_version text, p_meta jsonb)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(
    nullif(p_version, ''),
    concat_ws('|', nullif(p_meta->>'eTag', ''), nullif(p_meta->>'size', ''))
  );
$$;

revoke all on function private.f05_object_generation(text, jsonb) from public, anon, authenticated;

create or replace function public._guard_storage_upload_f05()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := NEW.bucket_id;
  v_meta jsonb := coalesce(NEW.metadata, '{}'::jsonb);
  v_mime text;
  v_size_text text;
  v_len_text text;
  v_size bigint;
  v_gen text;
begin
  if v_bucket is null
     or v_bucket not in ('residence-photos', 'chat-files') then
    return NEW;
  end if;

  -- Le MIME est exigé et contrôlé dans TOUS les cas, contrôle de permission provisoire compris.
  v_mime := lower(btrim(coalesce(v_meta->>'mimetype', '')));

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

  v_size_text := v_meta->>'size';

  -- INSERTION DÉFINITIVE : Storage fournit metadata.size. C'est la seule taille qui fait foi.
  -- contentLength (valeur provisoire du contrôle de permission) est ignoré quand size est là.
  -- La longueur est bornée avant le cast pour éviter tout dépassement bigint.
  if v_size_text is not null then
    if v_size_text !~ '^[0-9]+$' or length(v_size_text) > 12 then
      raise exception 'Upload rejected: valid size metadata is required'
        using errcode = 'check_violation';
    end if;

    v_size := v_size_text::bigint;

    if v_size < 12 then
      raise exception 'Upload rejected: file is too small'
        using errcode = 'check_violation';
    end if;

    if v_size > 5 * 1024 * 1024 then
      raise exception 'Upload rejected: file is too large'
        using errcode = 'check_violation';
    end if;

    -- Un nouvel envoi du même nom repart de zéro ; le drapeau (local à la transaction) autorise
    -- seul ce retour à pending dans private.storage_validation_state_guard().
    -- Génération de contenu = storage.objects.version (identifiant d'envoi attribué par Storage) ;
    -- à défaut, eTag + taille. Voir private.f05_object_generation().
    v_gen := private.f05_object_generation(NEW.version::text, v_meta);

    perform set_config('kaza.f05_reupload', 'on', true);

    insert into public.storage_upload_validations (
      bucket_id, object_name, status, declared_mime, byte_size,
      rejection_reason, validated_at, created_at, updated_at, generation
    )
    values (
      v_bucket, NEW.name, 'pending', v_mime, v_size,
      null, null, now(), now(), v_gen
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
        deleted_at = null,
        delete_attempts = 0,
        generation = excluded.generation,
        dispatched_generation = null,
        last_request_id = null,
        updated_at = now();

    perform set_config('kaza.f05_reupload', 'off', true);

    return NEW;
  end if;

  -- CONTRÔLE DE PERMISSION PROVISOIRE : pas de metadata.size.
  v_len_text := v_meta->>'contentLength';

  if v_len_text is not null then
    if v_len_text !~ '^[0-9]+$' or length(v_len_text) > 12 then
      raise exception 'Upload rejected: valid content length is required'
        using errcode = 'check_violation';
    end if;

    v_size := v_len_text::bigint;

    if v_size < 12 then
      raise exception 'Upload rejected: file is too small'
        using errcode = 'check_violation';
    end if;

    -- contentLength est la longueur de la REQUÊTE, pas celle du fichier : en multipart elle inclut
    -- les délimiteurs et en-têtes des parties (surcoût). La borne haute n'est donc qu'un filet
    -- (5 MiB + 64 KiB de marge de surcoût) ; la taille réelle est rebornée à 5 MiB exactement
    -- à l'insertion définitive (metadata.size). Le minimum reste valable : le surcoût ne peut
    -- qu'augmenter la longueur.
    if v_size > 5 * 1024 * 1024 + 65536 then
      raise exception 'Upload rejected: file is too large'
        using errcode = 'check_violation';
    end if;

    -- Autorisé comme simple contrôle de permission : aucun état persistant n'est créé.
    return NEW;
  end if;

  -- Ni size ni contentLength : n'est toléré que le contrôle de permission strictement
  -- provisoire (le MIME comme seule métadonnée). Toute autre ligne sans taille fiable échoue.
  if exists (select 1 from jsonb_object_keys(v_meta) k where k <> 'mimetype') then
    raise exception 'Upload rejected: valid size metadata is required'
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;


-- Le webhook ne stocke aucun jeton privilégié dans ses arguments.
-- Le secret dédié et l'URL sont lus depuis Vault au moment de l'appel. Seule l'INSERTION
-- DÉFINITIVE (metadata.size présent) déclenche un envoi : la ligne provisoire du contrôle de
-- permission de Storage ne produit aucune requête.
--
-- IDEMPOTENCE : l'envoi est REVENDIQUÉ par un UPDATE atomique conditionnel
--   ... where status = 'pending' and dispatched_generation is distinct from <génération de l'objet>
-- Deux triggers (INSERT puis UPDATE) ou deux sessions décrivant la même génération se
-- sérialisent sur le verrou de la ligne d'état : un seul revendique (et consomme UNE tentative),
-- l'autre voit dispatched_generation déjà posé et sort sans envoi. Un remplacement réel change la
-- génération (nouvelle version) et la garde d'upload a remis dispatched_generation à NULL : il est
-- donc validé comme un nouvel objet. La reprise cron (private.retry_stale_storage_validations)
-- n'est PAS soumise à cette revendication : c'est une vraie nouvelle tentative.
-- Un échec de MISE EN FILE pg_net n'annule pas l'upload : l'objet reste pending (illisible),
-- last_error est renseigné, last_request_id reste NULL et la reprise cron réémet l'envoi.
create or replace function private.dispatch_storage_validation_webhook()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_url text;
  v_secret text;
  v_apikey text;
  v_key text;
  v_req bigint;
begin
  if tg_op not in ('INSERT', 'UPDATE') then
    raise exception 'Unexpected storage validation event: %', tg_op;
  end if;

  if new.bucket_id is null
     or new.bucket_id not in ('residence-photos', 'chat-files') then
    return new;
  end if;

  if (new.metadata->>'size') is null then
    return new;
  end if;

  v_key := private.f05_object_generation(new.version::text, new.metadata);

  -- Revendication atomique, consultée AVANT la cible Vault : un événement redondant, ou une
  -- mise à jour d'objet sans état pending, ne lit pas Vault et ne peut pas échouer.
  update public.storage_upload_validations
     set retry_attempts = least(retry_attempts + 1, 5),
         last_attempt_at = clock_timestamp(),
         last_error = null,
         dispatched_generation = v_key,
         updated_at = clock_timestamp()
   where bucket_id = new.bucket_id
     and object_name = new.name
     and status = 'pending'
     and dispatched_generation is distinct from v_key;

  if not found then
    if tg_op = 'INSERT' and not exists (
      select 1 from public.storage_upload_validations v
       where v.bucket_id = new.bucket_id and v.object_name = new.name
    ) then
      raise exception 'Storage validation state missing for new object';
    end if;
    -- Doublon technique de la même génération, ou objet non pending : aucun envoi.
    return new;
  end if;

  -- Si la cible est invalide, l'exception annule aussi la revendication (même instruction).
  select t.o_url, t.o_secret, t.o_apikey
    into v_url, v_secret, v_apikey
    from private.storage_validation_target() as t;

  begin
    -- Un remplacement d'objet est, pour le validateur, un nouvel objet : l'événement reste INSERT.
    v_req := net.http_post(
      url := v_url,
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', tg_table_name,
        'schema', tg_table_schema,
        'record', to_jsonb(new),
        'old_record', null
      ),
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-storage-validation-secret', v_secret
      ) || case when v_apikey is null then '{}'::jsonb
                else jsonb_build_object('apikey', v_apikey) end,
      timeout_milliseconds := 10000
    );

    update public.storage_upload_validations
       set last_request_id = v_req
     where bucket_id = new.bucket_id
       and object_name = new.name
       and status = 'pending'
       and dispatched_generation = v_key;
  exception when others then
    update public.storage_upload_validations
       set last_error = left(sqlerrm, 500),
           last_request_id = null
     where bucket_id = new.bucket_id
       and object_name = new.name
       and status = 'pending';

    raise warning 'Storage validation webhook enqueue failed for bucket %, object %',
      new.bucket_id, new.name;
  end;

  return new;
end;
$function$;

-- Reprise automatique (pg_cron, chaque minute) :
--   1. pending dont l'objet a disparu            -> rejected (rien à supprimer : deleted_at posé)
--   2. pending au plafond de 5 envois            -> rejected (reste non lisible, suppression reprise en 5.)
--   3. pending ancien avec objet                 -> nouvel envoi au validateur
--   4. rejected dont l'objet a disparu           -> deleted_at posé
--   5. rejected dont la suppression a échoué     -> nouvel envoi : le validateur supprime à nouveau
--      (au plus 5 tentatives de suppression ; l'objet reste non lisible pendant tout ce temps)
create or replace function private.retry_stale_storage_validations()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $retry$
declare
  v_url text;
  v_secret text;
  v_apikey text;
  v_headers jsonb;
  r record;
  v_queued integer := 0;
  v_req bigint;
begin
  select t.o_url, t.o_secret, t.o_apikey
    into v_url, v_secret, v_apikey
    from private.storage_validation_target() as t;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-storage-validation-secret', v_secret
  ) || case when v_apikey is null then '{}'::jsonb
            else jsonb_build_object('apikey', v_apikey) end;

  -- 1. Les objets supprimés hors du processus normal ne doivent pas rester
  --    indéfiniment en attente.
  update public.storage_upload_validations v
     set status = 'rejected',
         rejection_reason = 'Storage object missing during validation retry',
         validated_at = null,
         deleted_at = clock_timestamp(),
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

  -- 2. Après cinq envois, arrêter les relances de validation : l'objet reste non lisible
  --    (rejected) et sa suppression est reprise ci-dessous.
  update public.storage_upload_validations v
     set status = 'rejected',
         rejection_reason = 'Automatic validation retry limit exceeded; object will be removed',
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

  -- 4. Rejeté, objet déjà absent : la suppression est acquise.
  update public.storage_upload_validations v
     set deleted_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where v.status = 'rejected'
     and v.deleted_at is null
     and not exists (
       select 1
         from storage.objects o
        where o.bucket_id = v.bucket_id
          and o.name = v.object_name
     );

  -- 3. pending ancien avec objet.
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
      v_req := net.http_post(
        url := v_url,
        body := jsonb_build_object(
          'type', 'INSERT',
          'table', 'objects',
          'schema', 'storage',
          'record', r.object_payload,
          'old_record', null
        ),
        params := '{}'::jsonb,
        headers := v_headers,
        timeout_milliseconds := 10000
      );

      update public.storage_upload_validations
         set last_request_id = v_req
       where bucket_id = r.bucket_id
         and object_name = r.object_name
         and status = 'pending';

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

  -- 5. Suppression des objets rejetés restés présents.
  for r in
    select
      v.bucket_id,
      v.object_name,
      to_jsonb(o) as object_payload
    from public.storage_upload_validations v
    join storage.objects o
      on o.bucket_id = v.bucket_id
     and o.name = v.object_name
    where v.status = 'rejected'
      and v.deleted_at is null
      and v.delete_attempts < 5
      and v.updated_at < clock_timestamp() - interval '5 minutes'
    order by v.updated_at
    limit 50
    for update of v skip locked
  loop
    update public.storage_upload_validations
       set delete_attempts = delete_attempts + 1,
           last_attempt_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where bucket_id = r.bucket_id
       and object_name = r.object_name
       and status = 'rejected'
       and deleted_at is null
       and delete_attempts < 5;

    if not found then
      continue;
    end if;

    begin
      v_req := net.http_post(
        url := v_url,
        body := jsonb_build_object(
          'type', 'INSERT',
          'table', 'objects',
          'schema', 'storage',
          'record', r.object_payload,
          'old_record', null
        ),
        params := '{}'::jsonb,
        headers := v_headers,
        timeout_milliseconds := 10000
      );

      update public.storage_upload_validations
         set last_request_id = v_req
       where bucket_id = r.bucket_id
         and object_name = r.object_name
         and status = 'rejected';

      v_queued := v_queued + 1;
    exception when others then
      update public.storage_upload_validations
         set last_error = left(SQLERRM, 500),
             updated_at = clock_timestamp()
       where bucket_id = r.bucket_id
         and object_name = r.object_name
         and status = 'rejected';

      raise warning 'Storage rejected-object deletion retry failed to enqueue for bucket %, object %',
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
