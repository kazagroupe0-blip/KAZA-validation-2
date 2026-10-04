-- ============================================================================
-- 20260924010000_storage_contract_convergence.sql
-- Converge user-upload limits and MIME contracts for residence/chat storage.
--
-- Contract:
--   residence-photos: JPEG/PNG/WebP, max 8 MiB, public bucket.
--   chat-files:      JPEG/PNG/WebP/PDF, max 8 MiB, private bucket.
--   expenses:        unchanged at 5 MiB (explicit bucket contract).
--   receipts:        unchanged in access policy; global/local limit remains
--                    bounded separately at 5 MiB when configured.
--
-- The trigger remains defense-in-depth alongside Storage bucket restrictions
-- and the validate-file-upload magic-byte check.
-- ============================================================================

update storage.buckets
set
  public = true,
  file_size_limit = 8 * 1024 * 1024,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'residence-photos';

update storage.buckets
set
  public = false,
  file_size_limit = 8 * 1024 * 1024,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
where id = 'chat-files';

create or replace function public._guard_storage_upload()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text := NEW.bucket_id;
  v_mime text := nullif(trim(coalesce(NEW.metadata->>'mimetype', '')), '');
  v_size bigint;
begin
  if v_bucket is null or v_bucket not in ('residence-photos', 'chat-files') then
    return NEW;
  end if;

  if v_mime is null then
    raise exception 'Type MIME manquant ou non autorisé'
      using errcode = 'check_violation';
  end if;

  if (NEW.metadata->>'size') is null or (NEW.metadata->>'size') !~ '^\\d+$' then
    raise exception 'Taille de fichier manquante ou invalide'
      using errcode = 'check_violation';
  end if;

  v_size := (NEW.metadata->>'size')::bigint;

  if v_size > 8 * 1024 * 1024 then
    raise exception 'Fichier trop volumineux : % octets', v_size
      using errcode = 'check_violation';
  end if;

  if v_bucket = 'residence-photos'
     and v_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Type MIME non autorisé pour les photos : %', v_mime
      using errcode = 'check_violation';
  end if;

  if v_bucket = 'chat-files'
     and not public._allowed_upload_mime(v_mime) then
    raise exception 'Type MIME non autorisé pour les pièces jointes : %', v_mime
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;
