-- Final ACL for the authenticated administration console.
-- Keep this explicit after later CREATE OR REPLACE migrations.
grant execute on function public.admin_moderate_residence(uuid, text, text) to authenticated;
