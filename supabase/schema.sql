-- inmo accounts: run this once in the Supabase dashboard (SQL Editor → New query).
-- It is safe to run again; every statement checks what already exists.
--
-- An account holds a profile (the name other people will see in shared
-- features) and, once the app has synced, the person's subjects, tasks and
-- sessions. Each person can only read and change their own rows.

-- ---------- Profiles ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Explicit, so this doesn't depend on the project granting new tables to the API
-- by itself. Row-level security below still limits each person to their own row.
revoke all on table public.profiles from anon, authenticated;
grant select, update (display_name) on table public.profiles to authenticated;

-- Each person can see and change only their own profile.
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- A profile is made for every new account, with the name given at sign-up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 40))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------- Deleting an account ----------

-- Called from Settings → Account → Delete account. Removes the signed-in
-- person's login; their profile (and later their synced data) goes with it
-- through "on delete cascade".
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------- Synced study data ----------
--
-- Subjects, tasks and sessions, one row per row in the app's local database,
-- keyed by the account and the row's id there. The app uploads changed rows
-- and downloads rows changed since its last sync (by server_ts). A delete is
-- kept as a row with deleted = true, so other devices learn of it. When two
-- devices change the same row, the change with the later updated_at (the
-- device's clock, in ms) wins; an older one is ignored.

create table if not exists public.courses (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  title text check (char_length(title) <= 300),
  code text check (char_length(code) <= 100),
  weekly_goal_seconds bigint,
  archived integer,
  exam_date text check (char_length(exam_date) <= 10),
  exam_target_seconds bigint,
  term text check (char_length(term) <= 100),
  color text check (char_length(color) <= 7),
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

create table if not exists public.tasks (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  course_id text check (char_length(course_id) <= 64),
  text text check (char_length(text) <= 1000),
  completed integer,
  due_date text check (char_length(due_date) <= 10),
  position bigint,
  completed_at bigint,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

create table if not exists public.sessions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  course_id text check (char_length(course_id) <= 64),
  duration bigint,
  created_at text check (char_length(created_at) <= 32),
  note text check (char_length(note) <= 2000),
  task_id text check (char_length(task_id) <= 64),
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

-- Stamps the server time on every write, keeps a row with its owner, and drops
-- an update older than what's stored.
create or replace function public.sync_row_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;
    end if;
    new.user_id = old.user_id;
  end if;
  new.server_ts = clock_timestamp();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['courses', 'tasks', 'sessions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on table public.%I to authenticated', t);
    execute format('create index if not exists %I on public.%I (user_id, server_ts)', t || '_changes', t);

    execute format('drop policy if exists "own rows: read" on public.%I', t);
    execute format('create policy "own rows: read" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('drop policy if exists "own rows: add" on public.%I', t);
    execute format('create policy "own rows: add" on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('drop policy if exists "own rows: change" on public.%I', t);
    execute format('create policy "own rows: change" on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);

    execute format('drop trigger if exists sync_row_write on public.%I', t);
    execute format('create trigger sync_row_write before insert or update on public.%I for each row execute function public.sync_row_write()', t);
  end loop;
end;
$$;
