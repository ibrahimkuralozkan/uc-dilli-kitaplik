-- Only account access metadata. No reader content or book tables.
create table if not exists public.reader_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.reader_memberships enable row level security;
revoke all on public.reader_memberships from anon, authenticated;
grant select on public.reader_memberships to authenticated;
create policy "Read own membership" on public.reader_memberships
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.create_reader_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.reader_memberships(user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.create_reader_membership() from public, anon, authenticated;
create trigger reader_membership_on_signup after insert on auth.users
  for each row execute function public.create_reader_membership();
insert into public.reader_memberships(user_id) select id from auth.users on conflict do nothing;
-- Manage status/expires_at only via trusted administration (e.g. SQL Editor).
-- Self-service accounts are free/active initially. Payment is intentionally not implemented.
