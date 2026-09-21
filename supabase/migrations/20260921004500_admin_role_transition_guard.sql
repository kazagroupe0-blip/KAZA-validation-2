-- 20260921004500_admin_role_transition_guard.sql
-- Prevent the generic role toggle action from demoting another administrator.

create or replace function public.admin_toggle_role(p_user_id uuid, p_role public.user_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_role public.user_role;
begin
  if not public.is_admin() then
    raise exception 'Seul un administrateur peut modifier les rôles' using errcode = '42501';
  end if;

  if p_role not in ('locataire', 'bailleur') then
    raise exception 'Rôle invalide : seuls locataire et bailleur sont autorisés' using errcode = '22023';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle' using errcode = 'P0001';
  end if;

  select role into v_target_role from public.profiles where id = p_user_id;

  if v_target_role is null then
    raise exception 'Utilisateur introuvable' using errcode = 'P0002';
  end if;

  if v_target_role = 'admin' then
    raise exception 'Le rôle administrateur ne peut pas être modifié par cette action' using errcode = '42501';
  end if;

  update public.profiles
     set role = p_role,
         consent_apdp = true,
         updated_at = now()
   where id = p_user_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    p_user_id,
    'system',
    'Votre rôle a été modifié',
    'Votre rôle sur Kaza est maintenant : ' || p_role || '.',
    jsonb_build_object('role', p_role)
  );
end;
$$;
