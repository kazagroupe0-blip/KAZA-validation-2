-- Fix the approved/pending -> draft withdrawal transition.
-- Draft listings must be both unpublished and unverified under
-- residences_moderation_visibility_check.

create or replace function public.withdraw_residence_publication(
  p_residence_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform set_config('kaza.internal_residence_transition','1',true);

  update public.residences
     set is_published = false,
         is_verified = false,
         moderation_status = case
           when moderation_status in ('pending','approved') then 'draft'
           else moderation_status
         end,
         updated_at = now()
   where id = p_residence_id
     and owner_id = auth.uid()
     and moderation_status in ('pending','approved');

  if not found then
    raise exception 'Bien introuvable ou déjà retiré' using errcode='P0002';
  end if;
end;
$function$;
