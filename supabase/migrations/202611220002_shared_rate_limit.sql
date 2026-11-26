begin;

create table public.profile_rate_limit_state (
  id boolean primary key default true check (id),
  entries integer not null default 0 check (entries between 0 and 100000)
);
insert into public.profile_rate_limit_state (id) values (true);

create table public.profile_rate_limits (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits integer not null check (hits > 0)
);
create index profile_rate_limits_expiry_idx on public.profile_rate_limits (window_start);

alter table public.profile_rate_limit_state enable row level security;
alter table public.profile_rate_limits enable row level security;
revoke all on public.profile_rate_limit_state, public.profile_rate_limits from public, anon, authenticated, service_role;

create function public.consume_profile_rate_limit(p_key text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entries integer;
  v_deleted integer;
  v_window timestamptz;
  v_hits integer;
  v_previous timestamptz;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit < 1 then
    raise exception 'Invalid rate limit arguments' using errcode = '22023';
  end if;

  update public.profile_rate_limit_state set entries = entries where id = true
    returning entries into strict v_entries;
  v_window := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());

  delete from public.profile_rate_limits where key_hash in (
    select key_hash from public.profile_rate_limits
    where window_start < v_window - interval '2 minutes'
    order by window_start limit 100
  );
  get diagnostics v_deleted = row_count;
  v_entries := v_entries - v_deleted;
  update public.profile_rate_limit_state set entries = v_entries where id = true;

  select hits, window_start into v_hits, v_previous
    from public.profile_rate_limits where key_hash = p_key;
  if found then
    if v_previous = v_window and v_hits >= p_limit then
      return false;
    end if;
    update public.profile_rate_limits
      set hits = case when v_previous = v_window then v_hits + 1 else 1 end,
          window_start = v_window
      where key_hash = p_key;
    return true;
  end if;

  if v_entries >= 100000 then
    return false;
  end if;
  insert into public.profile_rate_limits (key_hash, window_start, hits) values (p_key, v_window, 1);
  update public.profile_rate_limit_state set entries = v_entries + 1 where id = true;
  return true;
end;
$$;

revoke all on function public.consume_profile_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function public.consume_profile_rate_limit(text, integer) to service_role;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'profile_dashboard') then
    revoke all on public.profile_rate_limit_state, public.profile_rate_limits from profile_dashboard;
    grant execute on function public.consume_profile_rate_limit(text, integer) to profile_dashboard;
  end if;
end;
$$;

commit;
