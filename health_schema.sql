-- ============================================================
--  HEALTH — tabellen voor logboek, doelen en de Telegram-koppeling
--  Plak dit in Supabase -> SQL Editor -> Run
-- ============================================================

-- 1) Het logboek: elke regel is één ding dat je gegeten, gedronken,
--    gewogen, bewogen of geslapen hebt. De losse waarden staan in `data`.
create table if not exists public.health_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  kind text not null,                       -- food | drink | weight | activity | sleep | note
  source text not null default 'manual',    -- manual | telegram | fitbit
  title text,
  raw_text text,                            -- wat je oorspronkelijk stuurde
  data jsonb not null default '{}'::jsonb,  -- {kcal, prot, carb, fat, alc, weight, steps, sleep, ...}
  created_at timestamptz not null default now()
);
create index if not exists health_ts_idx on public.health_entries (user_id, ts desc);
alter table public.health_entries enable row level security;
drop policy if exists "health_own" on public.health_entries;
create policy "health_own" on public.health_entries for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2) Je dagdoelen.
create table if not exists public.health_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.health_settings enable row level security;
drop policy if exists "hs_own" on public.health_settings;
create policy "hs_own" on public.health_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3) Koppeling tussen je Telegram-account en je Supabase-gebruiker.
--    De app zet een `code`, jij stuurt "/start <code>" naar de bot,
--    de Edge Function vult dan `chat_id` in.
create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text unique,
  chat_id bigint unique,
  linked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.telegram_links enable row level security;
drop policy if exists "tg_own" on public.telegram_links;
create policy "tg_own" on public.telegram_links for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
