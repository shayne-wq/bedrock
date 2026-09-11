-- Bedrock — the client role, and how someone gets into an org.
--
-- The point of a 'client' is that we can hand a customer the keys to their own
-- deck without handing them the demolition tools. That is a claim about what
-- the DATABASE refuses, not about which buttons the console draws — a console
-- is a suggestion and `curl` is not. Every refusal is asserted here.
--
-- Fixture ids live in the cccc… space: aaaa… belongs to supabase/seed.sql and
-- bbbb… to rls_test.sql, and `db reset` loads the seed before either suite.
--
-- Run:  docker exec -i supabase_db_orebody psql -U postgres -d postgres \
--         -v ON_ERROR_STOP=1 -f - < supabase/tests/client_role_test.sql

\set ON_ERROR_STOP on
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values -- owns the org and builds the deck
       ('cccccccc-0000-0000-0000-00000000000a',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner@bedrock.test', 'x', now(), now(), now()),
       -- the customer, invited as a client
       ('cccccccc-0000-0000-0000-00000000000c',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'client@issuer.test', 'x', now(), now(), now()),
       -- invited, but has never confirmed their address
       ('cccccccc-0000-0000-0000-00000000000d',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'unconfirmed@issuer.test', 'x', null, now(), now()),
       -- nothing to do with any of it
       ('cccccccc-0000-0000-0000-00000000000e',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'stranger@example.com', 'x', now(), now(), now());

create or replace function become(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function unbecome() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ----------------------------------------------------------- the owner ----
select become('cccccccc-0000-0000-0000-00000000000a');

insert into orgs (id, name, slug)
values ('cccccccc-1111-0000-0000-000000000001', 'Issuer Co', 'issuer-co');

insert into projects (id, org_id, name, slug)
values ('cccccccc-2222-0000-0000-000000000001',
        'cccccccc-1111-0000-0000-000000000001', 'Toodoggone', 'toodoggone');

insert into decks (id, project_id, title)
values ('cccccccc-3333-0000-0000-000000000001',
        'cccccccc-2222-0000-0000-000000000001', 'North Zone');

insert into chapters (id, deck_id, ord, title, body)
values ('cccccccc-4444-0000-0000-000000000001',
        'cccccccc-3333-0000-0000-000000000001', 0, 'The property', 'As built.');

insert into share_links (id, deck_id, token, label)
values ('cccccccc-5555-0000-0000-000000000001',
        'cccccccc-3333-0000-0000-000000000001', 'tok-client-test', 'Website');

-- The owner invites the customer as a client.
insert into invites (org_id, email, role)
values ('cccccccc-1111-0000-0000-000000000001', 'Client@Issuer.test', 'client');

-- ...and someone who will never confirm their address.
insert into invites (org_id, email, role)
values ('cccccccc-1111-0000-0000-000000000001', 'unconfirmed@issuer.test', 'client');

-- ------------------------------------------------- redeeming an invite ----
-- A stranger holding no invitation gains nothing, and must not be able to
-- claim one by knowing the address on it.
select become('cccccccc-0000-0000-0000-00000000000e');
do $$ begin
  assert redeem_invites() = 0, 'a stranger redeemed something';
  assert (select count(*) from org_members
           where user_id = 'cccccccc-0000-0000-0000-00000000000e') = 0,
         'a stranger joined an org';
end $$;

-- An unconfirmed address must not inherit an invitation: signing up as
-- somebody else's address would otherwise collect their access.
select become('cccccccc-0000-0000-0000-00000000000d');
do $$ begin
  assert redeem_invites() = 0, 'an unconfirmed address redeemed an invitation';
end $$;

-- The real customer. Note the invite was written "Client@Issuer.test" and the
-- account is "client@issuer.test" — matching is case-insensitive or half the
-- invitations we send will silently never land.
select become('cccccccc-0000-0000-0000-00000000000c');
do $$ begin
  assert redeem_invites() = 1, 'the client did not redeem exactly one invitation';
  assert (select role from org_members
           where org_id = 'cccccccc-1111-0000-0000-000000000001'
             and user_id = 'cccccccc-0000-0000-0000-00000000000c') = 'client',
         'the client joined with the wrong role';
  -- Running it twice must not double-join or re-accept.
  assert redeem_invites() = 0, 'an invitation was redeemable twice';
end $$;

-- --------------------------------------------- what the client CAN do -----
do $$ begin
  assert (select count(*) from projects
           where id = 'cccccccc-2222-0000-0000-000000000001') = 1,
         'the client cannot see the project they were invited to';
  assert (select count(*) from decks
           where id = 'cccccccc-3333-0000-0000-000000000001') = 1,
         'the client cannot see their deck';
  -- The embed snippet comes from here, so reading it is the whole point.
  assert (select count(*) from share_links
           where id = 'cccccccc-5555-0000-0000-000000000001') = 1,
         'the client cannot read the share link their embed depends on';
end $$;

-- Editing the deck IS the job: text, camera, order, and removing a slide.
update chapters set title = 'Our property', body = 'Edited by the client.'
 where id = 'cccccccc-4444-0000-0000-000000000001';
do $$ begin
  assert (select title from chapters
           where id = 'cccccccc-4444-0000-0000-000000000001') = 'Our property',
         'the client could not edit a caption';
end $$;

insert into chapters (id, deck_id, ord, title)
values ('cccccccc-4444-0000-0000-000000000002',
        'cccccccc-3333-0000-0000-000000000001', 1, 'Added by the client');
delete from chapters where id = 'cccccccc-4444-0000-0000-000000000002';
do $$ begin
  assert (select count(*) from chapters
           where deck_id = 'cccccccc-3333-0000-0000-000000000001') = 1,
         'the client could not add and remove a slide';
end $$;

-- ------------------------------------------ what the client CANNOT do -----
-- Each of these is silent under RLS: the row simply is not visible to the
-- statement, so the delete affects nothing rather than raising. Asserting the
-- row still exists is the only honest way to test it.
delete from projects where id = 'cccccccc-2222-0000-0000-000000000001';
delete from decks    where id = 'cccccccc-3333-0000-0000-000000000001';
delete from share_links where id = 'cccccccc-5555-0000-0000-000000000001';
update share_links set revoked_at = now()
 where id = 'cccccccc-5555-0000-0000-000000000001';
update projects set name = 'Renamed by the client'
 where id = 'cccccccc-2222-0000-0000-000000000001';

select unbecome();
do $$ begin
  assert (select count(*) from projects
           where id = 'cccccccc-2222-0000-0000-000000000001') = 1,
         'a client DELETED a project';
  assert (select name from projects
           where id = 'cccccccc-2222-0000-0000-000000000001') = 'Toodoggone',
         'a client renamed a project';
  assert (select count(*) from decks
           where id = 'cccccccc-3333-0000-0000-000000000001') = 1,
         'a client DELETED a deck';
  assert (select count(*) from share_links
           where id = 'cccccccc-5555-0000-0000-000000000001') = 1,
         'a client DELETED a share link';
  assert (select revoked_at from share_links
           where id = 'cccccccc-5555-0000-0000-000000000001') is null,
         'a client REVOKED a share link';
end $$;

-- A client must not be able to invite anybody, or to promote themselves by
-- writing their own membership row.
select become('cccccccc-0000-0000-0000-00000000000c');
do $$
declare ok boolean := false;
begin
  begin
    insert into invites (org_id, email, role)
    values ('cccccccc-1111-0000-0000-000000000001', 'friend@issuer.test', 'admin');
  exception when insufficient_privilege or check_violation then ok := true;
  end;
  -- RLS refuses the insert outright (42501); if a future policy ever made it
  -- silently succeed, the count catches it.
  assert ok or (select count(*) from invites
                 where email = 'friend@issuer.test') = 0,
         'a client created an invitation';
end $$;

update org_members set role = 'owner'
 where org_id = 'cccccccc-1111-0000-0000-000000000001'
   and user_id = 'cccccccc-0000-0000-0000-00000000000c';
select unbecome();
do $$ begin
  assert (select role from org_members
           where org_id = 'cccccccc-1111-0000-0000-000000000001'
             and user_id = 'cccccccc-0000-0000-0000-00000000000c') = 'client',
         'a client PROMOTED THEMSELVES to owner';
end $$;

-- ------------------------------------------------------ the roster ---------
-- org_people is SECURITY DEFINER over auth.users, so its own WHERE clause is
-- the only thing standing between a client and every colleague's address.
select become('cccccccc-0000-0000-0000-00000000000c');
do $$ begin
  assert (select count(*) from org_people('cccccccc-1111-0000-0000-000000000001')) = 0,
         'a client read the org roster';
end $$;

select become('cccccccc-0000-0000-0000-00000000000e');
do $$ begin
  assert (select count(*) from org_people('cccccccc-1111-0000-0000-000000000001')) = 0,
         'a stranger read the org roster';
end $$;

select become('cccccccc-0000-0000-0000-00000000000a');
do $$ begin
  assert (select count(*) from org_people('cccccccc-1111-0000-0000-000000000001')) = 2,
         'the owner cannot see both people in their org';
  assert (select count(*) from org_people('cccccccc-1111-0000-0000-000000000001')
           where email = 'client@issuer.test' and role = 'client') = 1,
         'the roster does not name the client correctly';
end $$;

-- ------------------------------------------- the owner still has power ----
-- The whole change narrows write policies; prove it did not narrow them onto
-- the person who owns the place.
update projects set name = 'Toodoggone North'
 where id = 'cccccccc-2222-0000-0000-000000000001';
do $$ begin
  assert (select name from projects
           where id = 'cccccccc-2222-0000-0000-000000000001') = 'Toodoggone North',
         'the owner can no longer rename their own project';
  assert is_org_editor('cccccccc-1111-0000-0000-000000000001'),
         'the owner is not an editor';
end $$;

select become('cccccccc-0000-0000-0000-00000000000c');
do $$ begin
  assert not is_org_editor('cccccccc-1111-0000-0000-000000000001'),
         'the client counts as an editor';
  assert is_org_member('cccccccc-1111-0000-0000-000000000001'),
         'the client does not count as a member';
end $$;

select unbecome();
rollback;
