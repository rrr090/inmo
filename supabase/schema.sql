-- inmo accounts: run this once in the Supabase dashboard (SQL Editor → New query).
-- It is safe to run again; every statement checks what already exists.
--
-- An account holds a profile (a name and the friend code friends add it by)
-- and, once the app has synced, the person's subjects, tasks and sessions.
-- Each person can only read and change their own rows. The one exception is
-- friends: they see each other's name and status (see "Friends" at the end).

-- ---------- Profiles ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Added with friends (see "Friends" below): the code others add you with, and
-- whether friends see the subject you're studying.
alter table public.profiles add column if not exists friend_code text;
alter table public.profiles add column if not exists share_subject boolean not null default false;

alter table public.profiles enable row level security;

-- Explicit, so this doesn't depend on the project granting new tables to the API
-- by itself. Row-level security below still limits each person to their own row.
revoke all on table public.profiles from anon, authenticated;
grant select, update (display_name, share_subject) on table public.profiles to authenticated;

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

-- Only ever run by the trigger below, never called through the API.
revoke all on function public.handle_new_user() from public, anon, authenticated;

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

-- ---------- Friends ----------
--
-- Every account has a friend code. Adding someone's code sends them a request;
-- once they accept, each sees the other's status: whether they're studying
-- (and on which subject, if that person turned it on), their hours today and
-- this week, and their streak. Notes, tasks and sessions are never shared.
--
-- Requests and the friends list only go through the functions below: nobody
-- reads or writes the friendships table directly, and nobody can look up
-- another person's profile.

-- 8 characters from an alphabet without 0/O and 1/I, so a code read aloud or
-- copied by hand still works. 32^8 is about 10^12 codes.
create or replace function public.new_friend_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  -- Bytes of a random UUID that carry no version or variant bits.
  picks constant int[] := array[0, 1, 2, 3, 4, 5, 10, 11];
  bytes bytea;
  code text;
begin
  loop
    bytes := uuid_send(gen_random_uuid());
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + get_byte(bytes, picks[i]) % 32, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where friend_code = code);
  end loop;
  return code;
end;
$$;

revoke all on function public.new_friend_code() from public, anon, authenticated;

update public.profiles set friend_code = public.new_friend_code() where friend_code is null;
alter table public.profiles alter column friend_code set default public.new_friend_code();
alter table public.profiles alter column friend_code set not null;
create unique index if not exists profiles_friend_code on public.profiles (friend_code);

-- One row per pair: a request until the addressee accepts it.
create table if not exists public.friendships (
  requester uuid not null references auth.users (id) on delete cascade,
  addressee uuid not null references auth.users (id) on delete cascade,
  accepted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

create unique index if not exists friendships_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee on public.friendships (addressee);
alter table public.friendships enable row level security;
revoke all on table public.friendships from anon, authenticated;

create or replace function public.is_my_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f
    where f.accepted
      and ((f.requester = (select auth.uid()) and f.addressee = other)
        or (f.addressee = (select auth.uid()) and f.requester = other))
  );
$$;

revoke all on function public.is_my_friend(uuid) from public, anon;
grant execute on function public.is_my_friend(uuid) to authenticated;

-- What friends see, one row per account, written by the app: on start, stop,
-- pause and break, every minute during a session, and when the day's totals
-- change. Totals are for the person's own day and week (Monday to Sunday), in
-- their timezone (utc_offset_min); friends_overview() treats totals from an
-- earlier day or week as zero. A row not written for 5 minutes isn't studying:
-- the app was closed or lost its connection.
create table if not exists public.statuses (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  device text not null default '' check (char_length(device) <= 64),
  studying boolean not null default false,
  on_break boolean not null default false,
  paused boolean not null default false,
  elapsed_secs integer not null default 0 check (elapsed_secs between 0 and 172800),
  subject text check (char_length(subject) <= 200),
  subject_color text check (subject_color ~ '^#[0-9a-fA-F]{6}$'),
  today_secs integer not null default 0 check (today_secs between 0 and 10000000),
  week_secs integer not null default 0 check (week_secs between 0 and 10000000),
  streak_days integer not null default 0 check (streak_days between 0 and 100000),
  stats_date date,
  utc_offset_min smallint not null default 0 check (utc_offset_min between -900 and 900),
  last_session_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.statuses enable row level security;
revoke all on table public.statuses from anon, authenticated;
grant select, insert, update on table public.statuses to authenticated;

drop policy if exists "statuses: read own and friends'" on public.statuses;
create policy "statuses: read own and friends'" on public.statuses
  for select to authenticated using ((select auth.uid()) = user_id or public.is_my_friend(user_id));
drop policy if exists "statuses: add own" on public.statuses;
create policy "statuses: add own" on public.statuses
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "statuses: change own" on public.statuses;
create policy "statuses: change own" on public.statuses
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Stamps the server time and drops the subject unless the person shares it.
-- With two computers signed in, one in a session, the other doesn't mark the
-- account idle while the session's status is fresh.
create or replace function public.status_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.device <> new.device and (old.studying or old.on_break) and not (new.studying or new.on_break)
       and old.updated_at > now() - interval '5 minutes' then
      return null;
    end if;
    new.user_id = old.user_id;
  end if;
  if not coalesce((select p.share_subject from public.profiles p where p.id = new.user_id), false) then
    new.subject = null;
    new.subject_color = null;
  end if;
  if not new.studying then
    new.paused = false;
    new.elapsed_secs = 0;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.status_write() from public, anon, authenticated;

drop trigger if exists status_write on public.statuses;
create trigger status_write
  before insert or update on public.statuses
  for each row execute function public.status_write();

-- A row the app listens to (Realtime) so it hears at once about a new request,
-- an accepted one or a removed friend. Only its owner can read it.
create table if not exists public.friend_signals (
  user_id uuid primary key references auth.users (id) on delete cascade,
  rev bigint not null default 0
);

alter table public.friend_signals enable row level security;
revoke all on table public.friend_signals from anon, authenticated;
grant select on table public.friend_signals to authenticated;
drop policy if exists "friend signals: read own" on public.friend_signals;
create policy "friend signals: read own" on public.friend_signals
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.signal_friend(target uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.friend_signals (user_id, rev) values (target, 1)
  on conflict (user_id) do update set rev = public.friend_signals.rev + 1;
$$;

revoke all on function public.signal_friend(uuid) from public, anon, authenticated;

-- Realtime sends changes to these two tables to the people allowed to read them.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['statuses', 'friend_signals'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- Adds the person with that code: sends them a request, or accepts theirs if
-- they already sent one. Returns {result: requested | accepted | friends |
-- pending, name}.
create or replace function public.friend_add(code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  them uuid;
  their_name text;
  link public.friendships;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  select p.id, p.display_name into them, their_name
  from public.profiles p
  where p.friend_code = upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
  if them is null then
    raise exception 'No one has that friend code';
  end if;
  if them = me then
    raise exception 'That''s your own friend code';
  end if;

  select * into link from public.friendships f
  where (f.requester = me and f.addressee = them) or (f.requester = them and f.addressee = me);
  if found then
    if link.accepted then
      return jsonb_build_object('result', 'friends', 'name', their_name);
    elsif link.requester = me then
      return jsonb_build_object('result', 'pending', 'name', their_name);
    end if;
    update public.friendships set accepted = true where requester = them and addressee = me;
    perform public.signal_friend(them);
    return jsonb_build_object('result', 'accepted', 'name', their_name);
  end if;

  if (select count(*) from public.friendships f where f.requester = me and not f.accepted) >= 50 then
    raise exception 'You have 50 requests waiting. Cancel some before sending more';
  end if;
  if (select count(*) from public.friendships f where f.accepted and me in (f.requester, f.addressee)) >= 200 then
    raise exception 'You already have 200 friends, the most there can be';
  end if;
  insert into public.friendships (requester, addressee) values (me, them);
  perform public.signal_friend(them);
  return jsonb_build_object('result', 'requested', 'name', their_name);
end;
$$;

create or replace function public.friend_accept(other uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  update public.friendships set accepted = true
  where requester = other and addressee = auth.uid() and not accepted;
  if not found then
    raise exception 'That request was cancelled';
  end if;
  perform public.signal_friend(other);
end;
$$;

-- Removes a friend, declines a request or cancels one you sent.
create or replace function public.friend_remove(other uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from public.friendships
  where (requester = auth.uid() and addressee = other) or (requester = other and addressee = auth.uid());
  if found then
    perform public.signal_friend(other);
  end if;
end;
$$;

-- A new code, so an old one that was passed around stops working. Friends and
-- requests already made stay.
create or replace function public.friend_code_reset()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  code text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  update public.profiles set friend_code = public.new_friend_code() where id = auth.uid() returning friend_code into code;
  return code;
end;
$$;

-- Friends, and requests both ways, with each friend's status as it is now.
-- relation: friend | incoming | outgoing. Status columns are only filled for
-- friends; the subject only when that friend shares it.
create or replace function public.friends_overview()
returns table (
  user_id uuid,
  display_name text,
  relation text,
  since timestamptz,
  studying boolean,
  on_break boolean,
  paused boolean,
  elapsed_secs integer,
  subject text,
  subject_color text,
  today_secs integer,
  week_secs integer,
  streak_days integer,
  last_session_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with links as (
    select
      case when f.requester = (select auth.uid()) then f.addressee else f.requester end as other,
      case when f.accepted then 'friend' when f.requester = (select auth.uid()) then 'outgoing' else 'incoming' end as relation,
      f.created_at
    from public.friendships f
    where (select auth.uid()) in (f.requester, f.addressee)
  ),
  st as (
    select
      s.*,
      s.updated_at > now() - interval '5 minutes' as fresh,
      ((now() at time zone 'UTC') + make_interval(mins => s.utc_offset_min))::date as their_today
    from public.statuses s
    where s.user_id in (select other from links where relation = 'friend')
  )
  select
    l.other,
    p.display_name,
    l.relation,
    l.created_at,
    coalesce(s.fresh and s.studying, false),
    coalesce(s.fresh and s.on_break, false),
    coalesce(s.fresh and s.studying and s.paused, false),
    case when s.fresh and s.studying
      then s.elapsed_secs + case when s.paused then 0 else floor(extract(epoch from now() - s.updated_at))::int end
      else 0 end,
    case when s.fresh and (s.studying or s.on_break) and p.share_subject then s.subject end,
    case when s.fresh and (s.studying or s.on_break) and p.share_subject then s.subject_color end,
    case when s.stats_date = s.their_today then s.today_secs else 0 end,
    case when s.stats_date >= s.their_today - (extract(isodow from s.their_today)::int - 1) then s.week_secs else 0 end,
    case when s.stats_date = s.their_today or (s.stats_date = s.their_today - 1 and s.today_secs > 0) then s.streak_days else 0 end,
    s.last_session_at
  from links l
  join public.profiles p on p.id = l.other
  left join st s on s.user_id = l.other and l.relation = 'friend';
$$;

do $$
declare
  f text;
begin
  foreach f in array array['friend_add(text)', 'friend_accept(uuid)', 'friend_remove(uuid)', 'friend_code_reset()', 'friends_overview()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
