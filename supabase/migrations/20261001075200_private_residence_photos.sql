-- 20261001075200_private_residence_photos.sql
-- Promote the validated private-bucket state for residence photos.
-- The application already resolves residence photo references through
-- time-limited signed URLs (see PR #88).
--
-- This SQL is functionally identical to the validated shadow migration
-- 20260930072000_private_residence_photos.sql, with a new timestamp so it
-- remains ordered after the migrations already present on main/production.

update storage.buckets
   set public = false
 where id = 'residence-photos';

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

drop policy if exists "residence-photos-upload-owner" on storage.objects;

create policy "residence-photos-upload-owner"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'residence-photos'
  and (
    (storage.foldername(name))[1] = (select auth.uid()::text)
    or (
      (storage.foldername(name))[1] = 'residences'
      and (storage.foldername(name))[2] = (select auth.uid()::text)
    )
  )
);

do $$
begin
  if exists (
    select 1 from storage.buckets
     where id = 'residence-photos' and public = true
  ) then
    raise exception 'Residence photo bucket is still public';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname='storage'
       and tablename='objects'
       and policyname='residence-photos-read'
  ) then
    raise exception 'Residence photo SELECT policy missing';
  end if;
end
$$;
