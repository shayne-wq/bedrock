-- Orebody — RLS proof.
--
-- Every claim this schema makes about tenant isolation is asserted here, by
-- impersonating real users through request.jwt.claims (which is exactly what
-- PostgREST sets). A policy that is merely present proves nothing; these fail
-- loudly if any of them stops holding.
--
-- Run:  docker exec -i supabase_db_orebody psql -U postgres -d postgres \
--         -v ON_ERROR_STOP=1 -f - < supabase/tests/rls_test.sql

\set ON_ERROR_STOP on
begin;

-- Two tenants who must never see each other.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'alice@example.com', 'x', now(), now(), now()),
       ('22222222-2222-2222-2222-222222222222',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'mallory@example.com', 'x', now(), now(), now());

create or replace function become(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function become_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'anon')::text, true);
end $$;

create or replace function unbecome() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------------------------------------------------------------- alice ----
select become('11111111-1111-1111-1111-111111111111');

insert into orgs (id, name, slug)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice Minerals', 'alice-minerals');

-- The bootstrap trigger must have made her the owner in the same transaction,
-- or she has just locked herself out of the row she created.
do $$ begin
  assert (select count(*) from org_members
           where org_id = 'aaaaaaaa-0000-0000-0000-000000000001'
             and user_id = '11111111-1111-1111-1111-111111111111'
             and role = 'owner') = 1,
    'creating an org must make the creator its owner';
end $$;

do $$ begin
  assert (select count(*) from orgs) = 1, 'alice should see her own org';
end $$;

insert into projects (id, org_id, name, slug)
values ('aaaaaaaa-0000-0000-0000-000000000002',
        'aaaaaaaa-0000-0000-0000-000000000001', 'Elk Gold', 'elk-gold');

insert into datasets (project_id, kind, storage_path, synthetic, synthetic_note)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'blocks', 'a/b/c/blocks.bin',
        false, null);

insert into decks (id, project_id, title)
values ('aaaaaaaa-0000-0000-0000-000000000003',
        'aaaaaaaa-0000-0000-0000-000000000002', 'Siwash North');

insert into chapters (deck_id, ord, title)
values ('aaaaaaaa-0000-0000-0000-000000000003', 0, 'Opening'),
       ('aaaaaaaa-0000-0000-0000-000000000003', 1, 'The deposit');

insert into share_links (id, deck_id, label)
values ('aaaaaaaa-0000-0000-0000-000000000004',
        'aaaaaaaa-0000-0000-0000-000000000003', 'IR website');

-- A fabricated dataset must be forced to say so.
do $$ begin
  begin
    insert into datasets (project_id, kind, storage_path, synthetic)
    values ('aaaaaaaa-0000-0000-0000-000000000002', 'drills', 'a/b/c/d.bin', true);
    raise exception 'a synthetic dataset was accepted with no explanation';
  exception when check_violation then null;
  end;
end $$;

-- The share token must be url-safe: it goes straight into an iframe src.
do $$ declare tok text; begin
  select token into tok from share_links
   where id = 'aaaaaaaa-0000-0000-0000-000000000004';
  assert tok !~ '[+/=]', format('share token is not url-safe: %s', tok);
  assert length(tok) >= 30, format('share token is too short: %s', tok);
end $$;

-- ---------------------------------------------------- the whole point ------
select become('22222222-2222-2222-2222-222222222222');

do $$ begin
  assert (select count(*) from orgs)        = 0, 'mallory can see another org';
  assert (select count(*) from projects)    = 0, 'mallory can see another project';
  assert (select count(*) from datasets)    = 0, 'mallory can see another dataset';
  assert (select count(*) from decks)       = 0, 'mallory can see another deck';
  assert (select count(*) from chapters)    = 0, 'mallory can see another chapter';
  assert (select count(*) from share_links) = 0, 'mallory can see another share link';
  assert (select count(*) from org_members) = 0, 'mallory can enumerate members';
end $$;

-- Nor may she write into a tenancy she is not part of.
do $$ begin
  begin
    insert into decks (project_id, title)
    values ('aaaaaaaa-0000-0000-0000-000000000002', 'injected');
    raise exception 'mallory inserted a deck into another org';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Nor add herself to it.
do $$ begin
  begin
    insert into org_members (org_id, user_id, role)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            '22222222-2222-2222-2222-222222222222', 'owner');
    raise exception 'mallory joined another org';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ----------------------------------------------------------- anonymous ----
-- A visitor holding the anon key must get nothing at all. Everything a viewer
-- legitimately needs is served by an edge function on the service role after
-- the share token has been checked.
select become_anon();
do $$ begin
  assert (select count(*) from decks)       = 0, 'anon can read decks';
  assert (select count(*) from chapters)    = 0, 'anon can read chapters';
  assert (select count(*) from share_links) = 0, 'anon can read share links';
  assert (select count(*) from datasets)    = 0, 'anon can read datasets';
end $$;

-- ----------------------------------------------------------- analytics ----
-- Written by the service role (edge function), never by a viewer.
select unbecome();
insert into view_sessions (id, deck_id, share_link_id, watch_ms, chapters_seen,
                           completed, is_embed, referrer_host, referrer_path)
values ('aaaaaaaa-0000-0000-0000-000000000005',
        'aaaaaaaa-0000-0000-0000-000000000003',
        'aaaaaaaa-0000-0000-0000-000000000004',
        61000, 2, true, true, 'investors.example.com', '/projects/elk-gold');
insert into view_events (session_id, deck_id, t_ms, kind, chapter_ord, dwell_ms)
values ('aaaaaaaa-0000-0000-0000-000000000005',
        'aaaaaaaa-0000-0000-0000-000000000003', 0,     'chapter', 0, 21000),
       ('aaaaaaaa-0000-0000-0000-000000000005',
        'aaaaaaaa-0000-0000-0000-000000000003', 21000, 'chapter', 1, 40000);

-- A viewer must not be able to forge engagement.
select become_anon();
do $$ begin
  begin
    insert into view_sessions (deck_id) values ('aaaaaaaa-0000-0000-0000-000000000003');
    raise exception 'anon forged a view session';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from view_sessions) = 0, 'anon can read analytics';
end $$;

-- Alice sees her own numbers.
select become('11111111-1111-1111-1111-111111111111');
do $$ declare s record; begin
  assert (select count(*) from view_sessions) = 1, 'alice cannot see her analytics';
  select * into s from deck_summary('aaaaaaaa-0000-0000-0000-000000000003');
  assert s.sessions = 1,        format('sessions = %s', s.sessions);
  assert s.embed_sessions = 1,  format('embed_sessions = %s', s.embed_sessions);
  assert s.median_watch_ms = 61000, format('median_watch_ms = %s', s.median_watch_ms);
end $$;

do $$ declare n int; begin
  select count(*) into n from deck_chapter_funnel('aaaaaaaa-0000-0000-0000-000000000003');
  assert n = 2, format('funnel rows = %s', n);
  select sessions into n from deck_referrers('aaaaaaaa-0000-0000-0000-000000000003')
   where referrer_host = 'investors.example.com';
  assert n = 1, format('referrer sessions = %s', n);
end $$;

-- And crucially, the rollups are SECURITY INVOKER — so mallory calling them on
-- alice's deck id gets zeroes, not data. This is the one that would have been a
-- silent cross-tenant leak had the functions been declared definer.
select become('22222222-2222-2222-2222-222222222222');
do $$ declare s record; n int; begin
  select * into s from deck_summary('aaaaaaaa-0000-0000-0000-000000000003');
  assert coalesce(s.sessions, 0) = 0,
    format('rollup leaked another org''s analytics: %s sessions', s.sessions);
  select count(*) into n from deck_chapter_funnel('aaaaaaaa-0000-0000-0000-000000000003');
  assert n = 0, format('funnel leaked %s rows', n);
  select count(*) into n from deck_referrers('aaaaaaaa-0000-0000-0000-000000000003');
  assert n = 0, format('referrers leaked %s rows', n);
end $$;

select unbecome();
rollback;
