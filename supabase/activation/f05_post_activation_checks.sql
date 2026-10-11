-- KAZA F05 — contrôles en LECTURE SEULE après activation (aucune écriture).
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/activation/f05_post_activation_checks.sql

select 'triggers' as check_name, t.tgname, p.proname as function_name
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
 order by t.tgname;

select 'policies' as check_name, policyname, cmd
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and policyname in ('residence-photos-read', 'chat-files-read-owner');

select 'cron' as check_name, jobname, schedule, active
  from cron.job where jobname = 'storage-validation-retry-every-minute';

select 'states' as check_name, status, count(*) from public.storage_upload_validations group by status;

select 'stuck_pending_over_10min' as check_name, count(*)
  from public.storage_upload_validations
 where status = 'pending' and created_at < now() - interval '10 minutes';

-- Attendu : 'kaza-storage-content-validation' -> dispatch_storage_validation_webhook,
-- 'guard_storage_upload' -> _guard_storage_upload_f05, protect_objects_delete et
-- update_objects_updated_at toujours présents, un job cron actif, stuck_pending = 0.
