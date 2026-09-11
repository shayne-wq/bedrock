-- What a 'client' may do, and how one gets into an org in the first place.
--
-- Two problems, one file:
--
-- 1. Every write policy was `is_org_member`, so the only way to let a customer
--    edit their captions was to let them delete the project. Reads stay at
--    member; writes that destroy things move up to `is_org_editor`. Chapters
--    are the deliberate exception — editing chapters IS the client's job.
--
-- 2. There was no way to give anyone access at all. `org_members` can only be
--    written by an admin and needs a `user_id`, which does not exist until the
--    person has signed up — so the invitation had to be a row keyed by email
--    that redeems itself the first time they sign in.

-- --------------------------------------------------------------- helpers --
-- SECURITY DEFINER and a pinned search_path, matching is_org_member: a policy
-- on org_members that reads org_members through RLS recurses forever.
create function is_org_editor(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members
                  where org_id = p_org and user_id = auth.uid()
                    and role <> 'client');
$$;

comment on function is_org_editor is
  'Member of the org who is not a client — may destroy things. Reads use is_org_member.';

-- ------------------------------------------------------ tighten the writes --
-- projects already has a separate `project_read` for select, so narrowing the
-- write policy leaves clients able to see their own project. Permissive
-- policies are OR-ed, which is what keeps that true.
drop policy project_write on projects;
create policy project_write on projects for all
  using (is_org_editor(org_id)) with check (is_org_editor(org_id));

-- datasets, decks and share_links had ONE `for all` policy each, which was
-- also their only route to select. Narrowing it in place would have taken the
-- client's read away with the write, so each gains an explicit read first.
create policy dataset_read on datasets for select
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)));
drop policy dataset_all on datasets;
create policy dataset_write on datasets for all
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_editor(p.org_id)))
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_editor(p.org_id)));

create policy deck_read on decks for select
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)));
drop policy deck_all on decks;
create policy deck_write on decks for all
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_editor(p.org_id)))
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_editor(p.org_id)));

-- The client reads share_links because that is where the embed snippet comes
-- from. Creating and revoking them stays with us: a token is the thing that
-- decides who can see the deck at all.
create policy share_read on share_links for select
  using (exists (select 1 from decks d join projects p on p.id = d.project_id
                  where d.id = deck_id and is_org_member(p.org_id)));
drop policy share_all on share_links;
create policy share_write on share_links for all
  using (exists (select 1 from decks d join projects p on p.id = d.project_id
                  where d.id = deck_id and is_org_editor(p.org_id)))
  with check (exists (select 1 from decks d join projects p on p.id = d.project_id
                       where d.id = deck_id and is_org_editor(p.org_id)));

-- `chapter_all` is left exactly as it was, at is_org_member. Editing chapters
-- is the whole point of a client account, and a chapter is recoverable in a way
-- an uploaded dataset is not.

-- ------------------------------------------------------------- invitations --
create table invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  email       text not null check (position('@' in email) > 1),
  role        org_role not null default 'client',
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);

-- Case-insensitive, and only while it is outstanding: re-inviting somebody who
-- has already accepted is a legitimate thing to do after they were removed.
create unique index invites_pending_uk
  on invites (org_id, lower(email)) where accepted_at is null;
create index on invites (lower(email)) where accepted_at is null;

alter table invites enable row level security;

-- Admins of the org, and nobody else — an invite row names an email address,
-- so a client who could read the table would learn who else was invited.
create policy invite_manage on invites for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- ---------------------------------------------------------------- redeem ----
-- Called by the console immediately after sign-in. SECURITY DEFINER because
-- the caller is, by definition, not yet a member of the org they are joining
-- and so cannot write org_members through RLS.
--
-- The email comes from the JWT, never from an argument: taking it as a
-- parameter would let any signed-in user claim any pending invitation by
-- guessing an address.
create function redeem_invites() returns integer
language plpgsql security definer set search_path = public, auth as $$
declare
  v_email text;
  v_ok    boolean;
  v_uid   uuid := auth.uid();
  n       integer := 0;
begin
  if v_uid is null then return 0; end if;

  -- The address and its confirmation are read from auth.users, not from the
  -- JWT. Which claims GoTrue includes has changed between versions — an
  -- `email_verified` that is simply absent would read as "not verified" and
  -- silently make every invitation unredeemable — and the table is the thing
  -- that actually knows. An unconfirmed address must not inherit anything, or
  -- signing up as somebody else's address would collect their invitations.
  select lower(u.email), u.email_confirmed_at is not null
    into v_email, v_ok
    from auth.users u
   where u.id = v_uid;

  if not coalesce(v_ok, false) then return 0; end if;
  if v_email is null or v_email = '' then return 0; end if;

  insert into org_members (org_id, user_id, role)
  select i.org_id, v_uid, i.role
    from invites i
   where lower(i.email) = v_email
     and i.accepted_at is null
     and i.expires_at > now()
  on conflict (org_id, user_id) do nothing;

  update invites
     set accepted_at = now(), accepted_by = v_uid
   where lower(email) = v_email
     and accepted_at is null
     and expires_at > now();

  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function redeem_invites() from public;
grant execute on function redeem_invites() to authenticated;

comment on function redeem_invites is
  'Attach the caller to every org that has a live invitation for their verified JWT email. Returns how many were redeemed.';

-- ------------------------------------------------------------- the roster --
-- org_members stores a user_id and no address, so a console that wanted to
-- show "who has access" had nothing to print. auth.users is not readable
-- through RLS, so this is DEFINER — and therefore carries its own
-- authorisation check in the WHERE clause rather than trusting the caller.
create function org_people(p_org uuid)
returns table (user_id uuid, role org_role, email text, joined_at timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select m.user_id, m.role, u.email::text, m.added_at
    from org_members m
    join auth.users u on u.id = m.user_id
   where m.org_id = p_org
     and is_org_admin(p_org)
   order by m.added_at;
$$;

revoke all on function org_people(uuid) from public;
grant execute on function org_people(uuid) to authenticated;

comment on function org_people is
  'Members of an org with their email. Returns nothing unless the caller is an admin of that org.';
