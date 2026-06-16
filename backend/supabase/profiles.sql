create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  role text not null check (role in ('TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL')),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;

create policy "profiles_select_own"
on public.profiles
for select
using (auth.uid() = id);
