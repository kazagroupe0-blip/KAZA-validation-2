-- Shadow hardening: receipt storage reads require the exact receipt path.
--
-- The previous policy matched only the basename of receipts.file_url. A user
-- with a legitimate receipt ending in "receipt.pdf" could therefore satisfy
-- the SELECT policy for an unrelated object ending in the same basename.
-- Normalize legacy full URLs to the bucket-relative path and compare the full
-- path to storage.objects.name.

drop policy if exists "receipts-read-owner" on storage.objects;

create policy "receipts-read-owner"
on storage.objects
for select
using (
  bucket_id = 'receipts'
  and exists (
    select 1
      from public.receipts r
      join public.leases l
        on l.id = r.lease_id
     where (
       l.tenant_id = auth.uid()
       or l.landlord_id = auth.uid()
       or exists (
         select 1
           from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'::public.user_role
       )
     )
       and (
         case
           when position('/receipts/' in split_part(split_part(coalesce(r.file_url, ''), '?', 1), '#', 1)) > 0
             then 'receipts/' ||
                  split_part(
                    split_part(split_part(coalesce(r.file_url, ''), '?', 1), '#', 1),
                    '/receipts/',
                    2
                  )
           else ltrim(split_part(split_part(coalesce(r.file_url, ''), '?', 1), '#', 1), '/')
         end
       ) = objects.name
  )
);