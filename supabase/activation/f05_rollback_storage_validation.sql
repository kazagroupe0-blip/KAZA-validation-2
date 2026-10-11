-- KAZA F05 — ROLLBACK de l'activation (PHASE 2). À exécuter avec psql, une base à la fois :
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/activation/f05_rollback_storage_validation.sql
--
-- Restaure la garde d'origine, les politiques de lecture antérieures à F05 et retire le webhook
-- dédié et la reprise cron. Il NE recrée PAS l'ancien webhook legacy (son jeton ne doit pas être
-- réintroduit) : après rollback il n'y a plus de validation de contenu tant que F05 n'est pas
-- réactivé. Les lignes de public.storage_upload_validations sont conservées (preuve/audit).
-- ATTENTION : après rollback, un objet « rejected » dont la suppression a échoué redevient lisible
-- par les règles historiques : la liste en fin de script doit être traitée (suppression manuelle).

begin;

drop trigger if exists "kaza-storage-content-validation" on storage.objects;

drop trigger if exists guard_storage_upload on storage.objects;
create trigger guard_storage_upload
  before insert on storage.objects
  for each row
  execute function public._guard_storage_upload();

do $cron$
declare
  v_job_id bigint;
begin
  if to_regclass('cron.job') is not null then
    for v_job_id in
      execute 'select jobid from cron.job where jobname = $1'
        using 'storage-validation-retry-every-minute'
    loop
      execute 'select cron.unschedule($1)' using v_job_id;
    end loop;
  end if;
end;
$cron$;

drop policy if exists "residence-photos-read" on storage.objects;

create policy "residence-photos-read"
on storage.objects
for select
to public
using (
  bucket_id = 'residence-photos'
  and (
    owner_id = (select auth.uid()::text)
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

drop policy if exists "chat-files-read-owner" on storage.objects;

create policy "chat-files-read-owner" on storage.objects
  for select using (
    bucket_id = 'chat-files' and exists (
      select 1 from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where (c.tenant_id = auth.uid() or c.landlord_id = auth.uid())
        and exists (select 1 from unnest(m.attachments) a
                    where (regexp_match(a, '[^/]+$'))[1] = (regexp_match(name, '[^/]+$'))[1])
    )
  );

commit;

select v.bucket_id, v.object_name, v.status
  from public.storage_upload_validations v
  join storage.objects o on o.bucket_id = v.bucket_id and o.name = v.object_name
 where v.status <> 'validated'
 order by v.created_at;
