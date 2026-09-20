-- ============================================================================
-- Landlord payouts — queue + asynchronous FedaPay deposits
-- Payment confirmed by FedaPay -> one unique payout job -> async processor.
-- Direct clients can only read their own payout history; writes are server-only.
-- ============================================================================

create table if not exists public.landlord_payouts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.payments(id) on delete cascade,
  landlord_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'queued'
    check (status in ('queued', 'waiting_configuration', 'processing', 'sent', 'failed', 'manual_review')),
  recipient_provider text,
  recipient_phone text,
  provider_payout_id text unique,
  provider_reference text,
  provider_started_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz
);

create index if not exists landlord_payouts_queue_idx
  on public.landlord_payouts (status, next_attempt_at, created_at);

comment on column public.landlord_payouts.status is
  'Lifecycle: queued, waiting_configuration, processing, sent, failed or manual_review.';


create index if not exists landlord_payouts_landlord_idx
  on public.landlord_payouts (landlord_id, created_at desc);

alter table public.landlord_payouts enable row level security;

drop policy if exists landlord_payouts_select_own on public.landlord_payouts;
create policy landlord_payouts_select_own
  on public.landlord_payouts
  for select
  using (landlord_id = auth.uid() or public.is_admin());

drop trigger if exists landlord_payouts_touch on public.landlord_payouts;
create trigger landlord_payouts_touch
before update on public.landlord_payouts
for each row execute function public.touch_updated_at();

-- One payout job is created exactly when a real mobile-money payment becomes
-- confirmed. Cash payments never enter this queue.
create or replace function public.queue_landlord_payout_after_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'pending'
     and new.status = 'confirmed'
     and new.method = 'mobile_money'
     and new.provider in ('mtn', 'moov', 'celtiis') then
    insert into public.landlord_payouts (
      payment_id,
      landlord_id,
      amount
    )
    values (
      new.id,
      new.landlord_id,
      new.amount
    )
    on conflict (payment_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists payments_after_confirmed_landlord_payout on public.payments;
create trigger payments_after_confirmed_landlord_payout
after update of status on public.payments
for each row
execute function public.queue_landlord_payout_after_payment();

-- If a payout was waiting because the owner had not yet configured Mobile
-- Money, completing the profile immediately puts it back in the processing queue.
create or replace function public.requeue_landlord_payouts_after_profile_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'bailleur' and new.onboarding_completed = true then
    update public.landlord_payouts
       set status = 'queued',
           next_attempt_at = now(),
           last_error = null,
           updated_at = now()
     where landlord_id = new.id
       and status = 'waiting_configuration';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_after_completion_requeue_payouts on public.profiles;
create trigger profiles_after_completion_requeue_payouts
after update of onboarding_completed, momo_provider, momo_number on public.profiles
for each row
execute function public.requeue_landlord_payouts_after_profile_completion();

-- Atomic queue claiming. Only the Edge Function service role may claim jobs.
create or replace function public.claim_landlord_payouts(
  p_limit integer default 10
)
returns table (
  id uuid,
  payment_id uuid,
  landlord_id uuid,
  amount numeric,
  status text,
  recipient_provider text,
  recipient_phone text,
  provider_payout_id text,
  provider_reference text,
  provider_started_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Accès réservé au service de paiement' using errcode = '42501';
  end if;

  if p_limit < 1 or p_limit > 50 then
    raise exception 'Taille de lot invalide' using errcode = '22023';
  end if;

  return query
  with picked as (
    select lp.id
      from public.landlord_payouts lp
     where lp.status in ('queued')
       and lp.next_attempt_at <= now()
     order by lp.created_at
     for update skip locked
     limit p_limit
  )
  update public.landlord_payouts lp
     set status = 'processing',
         attempts = lp.attempts + 1,
         updated_at = now()
    from picked
   where lp.id = picked.id
  returning
    lp.id,
    lp.payment_id,
    lp.landlord_id,
    lp.amount,
    lp.status,
    lp.recipient_provider,
    lp.recipient_phone,
    lp.provider_payout_id,
    lp.provider_reference,
    lp.provider_started_at,
    lp.attempts;
end;
$$;

revoke execute on function public.claim_landlord_payouts(integer) from public, anon, authenticated;
grant execute on function public.claim_landlord_payouts(integer) to service_role;

create or replace function public.admin_retry_landlord_payout(
  p_payout_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Accès réservé à l’administration' using errcode = '42501';
  end if;

  update public.landlord_payouts
     set status = 'queued',
         next_attempt_at = now(),
         failed_at = null,
         last_error = null
   where id = p_payout_id
     and status in ('failed', 'manual_review');

  if not found then
    raise exception 'Reversement introuvable ou non relançable' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.admin_retry_landlord_payout(uuid) from public, anon;
grant execute on function public.admin_retry_landlord_payout(uuid) to authenticated;

-- Internal post-checks.
do $$
begin
  if to_regclass('public.landlord_payouts') is null then
    raise exception 'LANDLORD PAYOUTS: table missing';
  end if;

  if to_regprocedure('public.claim_landlord_payouts(integer)') is null then
    raise exception 'LANDLORD PAYOUTS: claim RPC missing';
  end if;

  if to_regprocedure('public.admin_retry_landlord_payout(uuid)') is null then
    raise exception 'LANDLORD PAYOUTS: admin retry RPC missing';
  end if;

  if not exists (
    select 1
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'payments'
       and tg.tgname = 'payments_after_confirmed_landlord_payout'
       and not tg.tgisinternal
  ) then
    raise exception 'LANDLORD PAYOUTS: payment trigger missing';
  end if;
end;
$$;

-- Process the queue every 5 minutes when pg_cron + pg_net are available.
do $$
declare
  v_has_cron boolean := exists (select 1 from pg_namespace where nspname = 'cron');
  v_has_net boolean := exists (select 1 from pg_namespace where nspname = 'net');
begin
  if not v_has_cron or not v_has_net then
    raise notice 'Landlord payout cron skipped: pg_cron or pg_net unavailable';
    return;
  end if;

  begin
    perform cron.unschedule('landlord-payouts-every-5-min');
  exception when others then
    null;
  end;

  perform cron.schedule('landlord-payouts-every-5-min', '*/5 * * * *', $cronjob$
    select net.http_post(
      url := coalesce(
        nullif(current_setting('app.settings.supabase_url', true), ''),
        (select secret from public._cron_secrets where name = 'supabase_url')
      ) || '/functions/v1/landlord-payouts',
      headers := jsonb_build_object(
        'x-cron-secret',
        coalesce(
          (select secret from public._cron_secrets where name = 'landlord-payouts'),
          (select secret from public._cron_secrets where name = 'overdue-cron'),
          nullif(current_setting('app.settings.cron_secret', true), '')
        )
      ),
      body := '{}'::jsonb
    );
  $cronjob$);
end $$;
