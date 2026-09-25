-- ============================================================================
-- F-23 : provider_ref — écriture initiale réservée à service_role, fail-closed.
--
-- Cause racine :
--   - Git : 1000000_production_convergence définit payments_guard_financial()
--     avec provider_ref dans le bloc « immuable absolu » ; fedapay-init
--     (client service_role) ne peut donc jamais enregistrer provider_ref sur
--     une base reconstruite depuis Git.
--   - PROD : 1000002_payment_provider_ref_finalization (appliquée hors Git)
--     autorise NULL -> valeur si auth.role() = 'service_role'. Quand
--     auth.role() est NULL (session sans claim role), la condition vaut NULL,
--     not (NULL) vaut NULL et le raise n'est pas exécuté : NULL -> valeur passe.
--
-- Cible : provider_ref ne change que de NULL vers une valeur non NULL, et
-- uniquement si coalesce(auth.role(), '') = 'service_role'. Toute autre
-- modification de provider_ref est refusée, y compris par service_role.
--
-- Portée : corps de public.payments_guard_financial() uniquement. Il est
-- identique au corps de PROD (1000002) à une condition près :
--   auth.role() = 'service_role'
--   -> coalesce(auth.role(), '') = 'service_role'
-- Le trigger payments_before_update_financial, les ACL, les policies et les
-- grants de payments ne sont pas modifiés (CREATE OR REPLACE conserve
-- propriétaire et ACL).
-- ============================================================================

create or replace function public.payments_guard_financial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.lease_id is distinct from old.lease_id
     or new.tenant_id is distinct from old.tenant_id
     or new.landlord_id is distinct from old.landlord_id then
    raise exception 'Le rattachement d''un paiement est immuable'
      using errcode = '42501';
  end if;

  if new.amount is distinct from old.amount
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.provider is distinct from old.provider then
    raise exception 'Les informations financières du paiement sont immuables'
      using errcode = '42501';
  end if;

  if new.provider_ref is distinct from old.provider_ref then
    if not (
      old.provider_ref is null
      and new.provider_ref is not null
      and coalesce(auth.role(), '') = 'service_role'
    ) then
      raise exception 'La référence prestataire du paiement est immuable'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

do $$
declare
  v_oid oid := to_regprocedure('public.payments_guard_financial()');
  v_def text;
  v_bad text[] := '{}';
begin
  if v_oid is null then
    raise exception 'F-23 : public.payments_guard_financial() absente';
  end if;
  v_def := pg_get_functiondef(v_oid);

  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'payments_guard_financial') <> 1 then
    v_bad := array_append(v_bad, 'plusieurs signatures payments_guard_financial');
  end if;
  if not (select prosecdef from pg_proc where oid = v_oid)
     or (select coalesce(proconfig, '{}') from pg_proc where oid = v_oid) <> array['search_path=public'] then
    v_bad := array_append(v_bad, 'SECURITY DEFINER ou search_path modifié');
  end if;
  if (select proacl::text from pg_proc where oid = v_oid) <> '{postgres=X/postgres,service_role=X/postgres}' then
    v_bad := array_append(v_bad, 'ACL = ' || coalesce((select proacl::text from pg_proc where oid = v_oid), '<NULL>'));
  end if;
  if position('coalesce(auth.role(), '''') = ''service_role''' in v_def) = 0 then
    v_bad := array_append(v_bad, 'condition fail-closed absente');
  end if;
  if position('and auth.role() = ''service_role''' in v_def) > 0 then
    v_bad := array_append(v_bad, 'ancienne condition NULL-permissive encore présente');
  end if;
  if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) <> '34602fc2379ec8ec59353aca9c3be965' then
    v_bad := array_append(v_bad, 'corps inattendu (md5 hors CR = '
      || (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) || ')');
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.payments'::regclass
       and t.tgname = 'payments_before_update_financial'
       and not t.tgisinternal
       and t.tgenabled = 'O'
       and t.tgfoid = v_oid
       and t.tgtype = 19  -- ROW | BEFORE | UPDATE
  ) then
    v_bad := array_append(v_bad, 'trigger payments_before_update_financial absent ou modifié');
  end if;

  if array_length(v_bad, 1) is not null then
    raise exception 'F-23 : % non-conformité(s) : %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;
end;
$$;
