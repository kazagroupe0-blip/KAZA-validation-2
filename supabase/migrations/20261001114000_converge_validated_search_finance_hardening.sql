-- Functional A/B audit convergence.
-- Source of behavior: validated Supabase-B runtime state.
-- Scope: public search input bounds + landlord finance/expense RPC hardening.
-- This migration is intentionally additive and does not rewrite prior migrations.

create or replace function public.search_residences(
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_km double precision default 10,
  p_type public.residence_type default null,
  p_max_price numeric default null,
  p_q text default null,
  p_city text default null,
  p_zone text default null,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table(
  id uuid,
  title text,
  description text,
  type public.residence_type,
  price_monthly numeric,
  deposit numeric,
  bedrooms integer,
  bathrooms integer,
  surface numeric,
  city text,
  zone text,
  address text,
  lat double precision,
  lng double precision,
  photos text[],
  status public.residence_status,
  distance_km double precision,
  owner_id uuid,
  owner_full_name text,
  owner_is_verified_landlord boolean,
  owner_is_premium boolean,
  features jsonb,
  standing_level text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_point geometry := null;
  v_radius_km double precision := least(greatest(coalesce(p_radius_km,10),0),100);
  v_limit integer := least(greatest(coalesce(p_limit,40),1),40);
  v_offset integer := least(greatest(coalesce(p_offset,0),0),10000);
begin
  if (p_lat is null)<>(p_lng is null) then
    raise exception 'Latitude et longitude doivent être fournies ensemble' using errcode='22023';
  end if;
  if p_lat is not null and (p_lat<>p_lat or p_lat<-90 or p_lat>90) then
    raise exception 'Latitude invalide' using errcode='22023';
  end if;
  if p_lng is not null and (p_lng<>p_lng or p_lng<-180 or p_lng>180) then
    raise exception 'Longitude invalide' using errcode='22023';
  end if;
  if p_radius_km<>p_radius_km then
    raise exception 'Rayon invalide' using errcode='22023';
  end if;
  if length(coalesce(p_q,''))>200 then
    raise exception 'Recherche trop longue' using errcode='22023';
  end if;
  if length(coalesce(p_city,''))>100 then
    raise exception 'Ville trop longue' using errcode='22023';
  end if;
  if length(coalesce(p_zone,''))>100 then
    raise exception 'Zone trop longue' using errcode='22023';
  end if;

  if p_lat is not null and p_lng is not null then
    v_point:=st_setsrid(st_makepoint(p_lng,p_lat),4326);
  end if;

  return query
  select
    r.id,r.title,r.description,r.type,r.price_monthly,r.deposit,
    r.bedrooms,r.bathrooms,r.surface,r.city,r.zone,r.address,r.lat,r.lng,
    r.photos,r.status,
    case when v_point is not null and r.geom is not null
      then st_distance(r.geom::geography,v_point::geography)/1000.0 else null end,
    case when auth.uid() is null then null else r.owner_id end,
    case when auth.uid() is null then null else p.full_name end,
    p.is_verified_landlord,p.is_premium,r.features,public.residence_standing(r.features)
  from public.residences r
  left join public.profiles p on p.id=r.owner_id
  where r.is_published=true
    and r.is_verified=true
    and r.moderation_status='approved'
    and r.status='libre'
    and (p_type is null or r.type=p_type)
    and (p_max_price is null or r.price_monthly<=p_max_price)
    and (p_city is null or r.city ilike p_city)
    and (p_zone is null or r.zone ilike p_zone)
    and (p_q is null or r.title ilike '%'||p_q||'%' or r.description ilike '%'||p_q||'%')
    and (
      v_point is null
      or r.geom is null
      or st_dwithin(r.geom::geography,v_point::geography,v_radius_km*1000)
    )
  order by
    case when v_point is not null and r.geom is not null
      then r.geom <-> v_point else null end asc nulls last,
    r.created_at desc
  limit v_limit offset v_offset;
end
$function$;

create or replace function public.create_expense(
  p_category public.expense_category,
  p_amount numeric,
  p_date date,
  p_description text default null,
  p_residence_id uuid default null,
  p_receipt_path text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role public.user_role;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Non authentifié' using errcode = '28000';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select role into v_role from public.profiles where id = v_uid;
    if v_role is distinct from 'bailleur' then
      raise exception 'Seuls les bailleurs peuvent gérer les dépenses' using errcode = '42501';
    end if;
  end if;

  if p_amount is null
     or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <= 0 then
    raise exception 'Montant invalide' using errcode = '22023';
  end if;

  if p_date > current_date then
    raise exception 'Date future non autorisée' using errcode = '22023';
  end if;

  if p_residence_id is not null
     and not exists (
       select 1
         from public.residences r
        where r.id = p_residence_id
          and r.owner_id = v_uid
     )
  then
    raise exception 'Résidence introuvable ou non autorisée' using errcode = '42501';
  end if;

  insert into public.expenses (
    landlord_id,
    residence_id,
    category,
    amount,
    date,
    description,
    receipt_url
  )
  values (
    v_uid,
    p_residence_id,
    p_category,
    p_amount,
    p_date,
    p_description,
    p_receipt_path
  )
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.update_expense(
  p_id uuid,
  p_category public.expense_category,
  p_amount numeric,
  p_date date,
  p_description text default null,
  p_residence_id uuid default null,
  p_receipt_path text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role public.user_role;
begin
  if v_uid is null then
    raise exception 'Non authentifié' using errcode = '28000';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select role into v_role from public.profiles where id = v_uid;
    if v_role is distinct from 'bailleur' then
      raise exception 'Seuls les bailleurs peuvent gérer les dépenses' using errcode = '42501';
    end if;
  end if;

  if p_amount is null
     or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <= 0 then
    raise exception 'Montant invalide' using errcode = '22023';
  end if;

  if p_date > current_date then
    raise exception 'Date future non autorisée' using errcode = '22023';
  end if;

  if p_residence_id is not null
     and not exists (
       select 1
         from public.residences r
        where r.id = p_residence_id
          and r.owner_id = v_uid
     )
  then
    raise exception 'Résidence introuvable ou non autorisée' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.expenses
     where id = p_id
       and landlord_id = v_uid
  ) then
    raise exception 'Dépense introuvable' using errcode = 'P0002';
  end if;

  update public.expenses
     set category = p_category,
         amount = p_amount,
         date = p_date,
         description = p_description,
         residence_id = p_residence_id,
         receipt_url = p_receipt_path
   where id = p_id
     and landlord_id = v_uid;
end;
$function$;

create or replace function public.delete_expense(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role public.user_role;
begin
  if v_uid is null then
    raise exception 'Non authentifié' using errcode = '28000';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select role into v_role from public.profiles where id = v_uid;
    if v_role is distinct from 'bailleur' then
      raise exception 'Seuls les bailleurs peuvent gérer les dépenses' using errcode = '42501';
    end if;
  end if;

  if not exists (
    select 1
      from public.expenses
     where id = p_id
       and landlord_id = v_uid
  ) then
    raise exception 'Dépense introuvable' using errcode = 'P0002';
  end if;

  delete from public.expenses
   where id = p_id
     and landlord_id = v_uid;
end;
$function$;

create or replace function public.landlord_cashflow(
  p_from date,
  p_to date
)
returns table(
  month date,
  expected numeric,
  collected numeric,
  overdue numeric,
  expenses numeric,
  net numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid:=auth.uid();
begin
  if v_uid is null then
    raise exception 'Non authentifié' using errcode='28000';
  end if;
  if p_from>p_to then
    raise exception 'Période invalide' using errcode='22023';
  end if;
  if p_to-p_from>3660 then
    raise exception 'Période trop longue (maximum 10 ans)' using errcode='22023';
  end if;

  return query
  with months as (
    select generate_series(
      date_trunc('month',p_from)::date,
      date_trunc('month',p_to)::date,
      '1 month'
    )::date month_start
  ),
  expected_monthly as (
    select
      m.month_start,
      coalesce(sum(l.monthly_rent),0)::numeric(12,2) expected
    from months m
    left join public.leases l
      on l.landlord_id=v_uid
     and l.status='active'
     and l.start_date <= (m.month_start+interval '1 month - 1 day')::date
     and (l.end_date is null or l.end_date>=m.month_start)
    group by m.month_start
  ),
  collected_monthly as (
    select
      m.month_start,
      coalesce(sum(
        p.amount * (
          least(p.period_end,(m.month_start+interval '1 month - 1 day')::date)
          - greatest(p.period_start,m.month_start)+1
        )::numeric
        / nullif((p.period_end-p.period_start+1)::numeric,0)
      ),0)::numeric(12,2) collected
    from months m
    left join public.payments p
      on p.landlord_id=v_uid
     and p.status='confirmed'
     and p.period_start <= (m.month_start+interval '1 month - 1 day')::date
     and p.period_end>=m.month_start
    group by m.month_start
  ),
  overdue_monthly as (
    select
      m.month_start,
      coalesce(sum(l.monthly_rent),0)::numeric(12,2) overdue
    from months m
    left join public.leases l
      on l.landlord_id=v_uid
     and l.status='active'
     and l.date_fn_couverture<m.month_start
     and not exists(
       select 1
       from public.payments p
       where p.lease_id=l.id
         and p.status in ('pending','confirmed')
         and p.period_start <= (m.month_start+interval '1 month - 1 day')::date
         and p.period_end>=m.month_start
     )
    group by m.month_start
  ),
  expenses_monthly as (
    select
      date_trunc('month',e.date)::date month_start,
      coalesce(sum(e.amount),0)::numeric(12,2) expenses
    from public.expenses e
    where e.landlord_id=v_uid
      and e.date>=p_from
      and e.date<=p_to
    group by date_trunc('month',e.date)
  )
  select
    m.month_start,
    em.expected,
    coalesce(cm.collected,0),
    coalesce(om.overdue,0),
    coalesce(xm.expenses,0),
    coalesce(cm.collected,0)-coalesce(xm.expenses,0)
  from months m
  left join expected_monthly em on em.month_start=m.month_start
  left join collected_monthly cm on cm.month_start=m.month_start
  left join overdue_monthly om on om.month_start=m.month_start
  left join expenses_monthly xm on xm.month_start=m.month_start
  order by m.month_start;
end;
$function$;

create or replace function public.landlord_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid:=auth.uid();
  v_role public.user_role;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Non authentifié' using errcode='28000';
  end if;
  select role into v_role from public.profiles where id=v_uid;
  if v_role not in ('bailleur','admin') then
    raise exception 'Accès réservé aux bailleurs' using errcode='42501';
  end if;

  select jsonb_build_object(
    'total_properties',coalesce(prop_stats.total,0),
    'occupied',coalesce(prop_stats.occupied,0),
    'vacant',coalesce(prop_stats.vacant,0),
    'in_visit',coalesce(prop_stats.in_visit,0),
    'maintenance',coalesce(prop_stats.maintenance,0),
    'total_monthly_rent',coalesce(lease_stats.total_monthly_rent,0),
    'collected_this_month',coalesce(payment_stats.collected_this_month,0),
    'overdue_total',coalesce(overdue_stats.overdue_total,0),
    'overdue_count',coalesce(overdue_stats.overdue_count,0),
    'pending_receipts',coalesce(receipt_stats.pending_count,0),
    'upcoming_due_7d',coalesce(upcoming_stats.upcoming_count,0),
    'expenses_this_month',coalesce(expense_stats.expenses_this_month,0)
  )
  into v_result
  from (
    select
      count(*)::int total,
      count(distinct l.residence_id)::int occupied,
      count(*) filter(where r.status='libre')::int vacant,
      count(*) filter(where r.status='en_visite')::int in_visit,
      count(*) filter(where r.status='maintenance')::int maintenance
    from public.residences r
    left join public.leases l
      on l.residence_id=r.id
     and l.landlord_id=r.owner_id
     and l.status='active'
    where r.owner_id=v_uid
  ) prop_stats
  cross join (
    select coalesce(sum(monthly_rent),0)::numeric(12,2) total_monthly_rent
    from public.leases
    where landlord_id=v_uid and status='active'
  ) lease_stats
  cross join (
    select coalesce(sum(allocated_amount),0)::numeric(12,2) collected_this_month
    from (
      select p.amount * (
        least(p.period_end,(date_trunc('month',now())+interval '1 month - 1 day')::date)
        - greatest(p.period_start,date_trunc('month',now())::date)+1
      )::numeric
      / nullif((p.period_end-p.period_start+1)::numeric,0) allocated_amount
      from public.payments p
      where p.landlord_id=v_uid
        and p.status='confirmed'
        and p.period_start <= (date_trunc('month',now())+interval '1 month - 1 day')::date
        and p.period_end >= date_trunc('month',now())::date
    ) allocated
  ) payment_stats
  cross join (
    select
      coalesce(sum(monthly_rent),0)::numeric(12,2) overdue_total,
      count(*)::int overdue_count
    from public.leases l
    where l.landlord_id=v_uid
      and l.status='active'
      and l.date_fn_couverture<current_date
      and not exists (
        select 1
        from public.payments p
        where p.lease_id=l.id
          and p.status in ('pending','confirmed')
          and p.period_end >= l.date_fn_couverture
      )
  ) overdue_stats
  cross join (
    select count(*)::int pending_count
    from public.receipts
    where landlord_id=v_uid
      and status='pending_signature'
  ) receipt_stats
  cross join (
    select count(*)::int upcoming_count
    from public.leases l
    where l.landlord_id=v_uid
      and l.status='active'
      and l.date_fn_couverture>=current_date
      and l.date_fn_couverture<=current_date+7
  ) upcoming_stats
  cross join (
    select coalesce(sum(e.amount),0)::numeric(12,2) expenses_this_month
    from public.expenses e
    where e.landlord_id=v_uid
      and e.date>=date_trunc('month',current_date)::date
      and e.date<(date_trunc('month',current_date)+interval '1 month')::date
  ) expense_stats;

  return v_result;
end;
$function$;
