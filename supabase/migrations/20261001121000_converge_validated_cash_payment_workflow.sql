-- Functional A/B audit convergence.
-- Source of behavior: validated Supabase-B cash-payment workflow.
-- Scope: lock the lease, require an active lease, validate period bounds,
-- and prevent overlapping pending/confirmed payment periods.

create or replace function public.report_cash_payment(
  p_lease_id uuid,
  p_amount numeric,
  p_period_start date,
  p_period_end date
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lease public.leases%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentification requise' using errcode='28000';
  end if;

  select * into v_lease
    from public.leases
   where id = p_lease_id
   for update;

  if v_lease.id is null then
    raise exception 'Bail introuvable' using errcode='P0002';
  end if;

  if v_lease.tenant_id is distinct from auth.uid() then
    raise exception 'Vous n''êtes pas le locataire de ce bail' using errcode='42501';
  end if;

  if v_lease.status is distinct from 'active' then
    raise exception 'Ce bail n''est plus actif' using errcode='P0001';
  end if;

  if p_period_start is null
     or p_period_end is null
     or p_period_end < p_period_start then
    raise exception 'Période de paiement invalide' using errcode='22023';
  end if;

  if p_period_start < v_lease.date_fn_couverture then
    raise exception 'La période déclarée chevauche une période déjà couverte' using errcode='P0001';
  end if;

  if v_lease.end_date is not null
     and p_period_end > v_lease.end_date then
    raise exception 'La période dépasse la fin du bail' using errcode='P0001';
  end if;

  if exists (
    select 1
      from public.payments p
     where p.lease_id = p_lease_id
       and p.status in ('pending','confirmed')
       and p.period_start <= p_period_end
       and p.period_end >= p_period_start
  ) then
    raise exception 'Un paiement couvre déjà cette période' using errcode='P0001';
  end if;

  insert into public.payments (
    lease_id,
    tenant_id,
    landlord_id,
    amount,
    period_start,
    period_end,
    method,
    provider,
    status
  )
  values (
    p_lease_id,
    v_lease.tenant_id,
    v_lease.landlord_id,
    p_amount,
    p_period_start,
    p_period_end,
    'cash',
    'cash',
    'pending'
  );
end;
$function$;
