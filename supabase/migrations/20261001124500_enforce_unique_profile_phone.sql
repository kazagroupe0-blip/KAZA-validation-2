-- A phone number is an account identifier for KAZA.
-- Enforce uniqueness while allowing users without a phone.

create unique index if not exists profiles_phone_unique_idx
  on public.profiles (phone)
  where phone is not null;
