-- Bedrock — client onboarding intake.
--
-- The claims worth testing are the ones about liability: that a client cannot
-- skip the signature, cannot alter what they signed, cannot reach another
-- company's files, and that the people who get access are exactly the people
-- the signer named — as clients, never more. Every one of those is a refusal by
-- the DATABASE, asserted here, because the console is only a suggestion.
--
-- Fixture ids live in the dddd… space (aaaa… seed, bbbb… rls, cccc… client).
--
-- Run:  docker exec -i supabase_db_orebody psql -U postgres -d postgres \
--         -v ON_ERROR_STOP=1 -f - < supabase/tests/intake_test.sql

\set ON_ERROR_STOP on
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('dddddddd-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'staff@bedrock.test', 'x', now(), now(), now()),
       ('dddddddd-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'ceo@issuer.test', 'x', now(), now(), now()),
       ('dddddddd-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'unconfirmed@issuer.test', 'x', null, now(), now()),
       ('dddddddd-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'rival@other.test', 'x', now(), now(), now()),
       -- already a client of the issuer before the intake names them
       ('dddddddd-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'cfo@issuer.test', 'x', now(), now(), now());

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

-- Raises unless the statement is refused. Used where RLS or a trigger is
-- expected to throw rather than silently match nothing.
create or replace function refused(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;
grant execute on function refused(text) to authenticated;

-- ------------------------------------------------------------- fixtures ----
select unbecome();
insert into orgs (id, name, slug) values
  ('dddddddd-1111-0000-0000-000000000001', 'Issuer Gold Corp', 'issuer-gold'),
  ('dddddddd-1111-0000-0000-000000000002', 'Rival Metals', 'rival-metals');
insert into org_members (org_id, user_id, role) values
  ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', 'owner'),
  ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000c', 'client'),
  ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000d', 'client'),
  ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000f', 'client'),
  ('dddddddd-1111-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000e', 'owner');
insert into projects (id, org_id, name, slug) values
  ('dddddddd-2222-0000-0000-000000000001', 'dddddddd-1111-0000-0000-000000000001', 'Golden Ridge', 'golden-ridge'),
  ('dddddddd-2222-0000-0000-000000000002', 'dddddddd-1111-0000-0000-000000000002', 'Rival Hill', 'rival-hill');

-- ------------------------------------------- the client fills it in -------
select become('dddddddd-0000-0000-0000-00000000000c');

insert into intakes (id, project_id)
values ('dddddddd-3333-0000-0000-000000000001', 'dddddddd-2222-0000-0000-000000000001');

select intake_save('dddddddd-3333-0000-0000-000000000001', 'company',
                   '{"commodity":"Gold","epsg":"26910"}');
select intake_save('dddddddd-3333-0000-0000-000000000001', 'access',
                   '{"people":[{"name":"New Geologist","email":"Geo@Issuer.test","title":"VP Exploration"},
                               {"name":"Dup","email":"geo@issuer.test"},
                               {"name":"Already in","email":"cfo@issuer.test"},
                               {"name":"Junk","email":"not-an-address"}]}');

do $$ begin
  assert (select answers->'company'->>'commodity' from intakes
           where id = 'dddddddd-3333-0000-0000-000000000001') = 'Gold',
         'the client could not save a section';
  assert (select answers ? 'access' from intakes
           where id = 'dddddddd-3333-0000-0000-000000000001'),
         'saving one section dropped another';
end $$;

-- Skipping the signature by writing the status directly.
do $$ begin
  assert refused($q$update intakes set status = 'submitted'
                    where id = 'dddddddd-3333-0000-0000-000000000001'$q$),
         'a client marked an intake submitted without signing';
  assert refused($q$update intakes set submitted_by = auth.uid()
                    where id = 'dddddddd-3333-0000-0000-000000000001'$q$),
         'a client forged who submitted an intake';
end $$;

-- A client cannot open an intake directly in the submitted state either.
do $$ begin
  assert refused($q$insert into intakes (project_id, status)
                    values ('dddddddd-2222-0000-0000-000000000001', 'accepted')$q$),
         'a client created an intake already accepted';
end $$;

-- Files: into their own org's folder, as themselves.
insert into storage.objects (bucket_id, name)
values ('intake', 'dddddddd-1111-0000-0000-000000000001/dddddddd-2222-0000-0000-000000000001/f1/model.omf');
insert into intake_files (intake_id, slot, filename, storage_path, bytes)
values ('dddddddd-3333-0000-0000-000000000001', 'blocks', 'model.omf',
        'dddddddd-1111-0000-0000-000000000001/dddddddd-2222-0000-0000-000000000001/f1/model.omf', 1234);

do $$ begin
  -- Into another company's folder.
  assert refused($q$insert into storage.objects (bucket_id, name) values ('intake',
    'dddddddd-1111-0000-0000-000000000002/dddddddd-2222-0000-0000-000000000002/x/steal.csv')$q$),
    'a client wrote into another org''s intake folder';
  -- Their own org in the path, another org's project behind it.
  assert refused($q$insert into storage.objects (bucket_id, name) values ('intake',
    'dddddddd-1111-0000-0000-000000000001/dddddddd-2222-0000-0000-000000000002/x/mix.csv')$q$),
    'a client wrote under a project that is not their org''s';
  -- A file row attributed to somebody else.
  assert refused($q$insert into intake_files (intake_id, slot, filename, storage_path, uploaded_by)
    values ('dddddddd-3333-0000-0000-000000000001', 'drills', 'x.csv',
            'dddddddd-1111-0000-0000-000000000001/dddddddd-2222-0000-0000-000000000001/f2/x.csv',
            'dddddddd-0000-0000-0000-00000000000a')$q$),
    'a client uploaded a file in someone else''s name';
end $$;

-- ------------------------------------------------- an outsider -----------
select become('dddddddd-0000-0000-0000-00000000000e');
do $$ begin
  assert (select count(*) from intakes) = 0, 'an outsider can see another company''s intake';
  assert (select count(*) from intake_files) = 0, 'an outsider can see another company''s files';
  assert (select count(*) from storage.objects where bucket_id = 'intake') = 0,
         'an outsider can read another company''s uploaded files';
  assert refused($q$select intake_save('dddddddd-3333-0000-0000-000000000001', 'company', '{}')$q$),
         'an outsider wrote into another company''s intake';
  assert refused($q$select submit_intake('dddddddd-3333-0000-0000-000000000001',
                    'Mallory', 'CEO', '2026-10-27', 5)$q$),
         'an outsider signed another company''s intake';
end $$;

-- ------------------------------------------------- signing ---------------
-- An unconfirmed address cannot sign: anyone can type any address at sign-up.
select become('dddddddd-0000-0000-0000-00000000000d');
do $$ begin
  assert refused($q$select submit_intake('dddddddd-3333-0000-0000-000000000001',
                    'Someone', 'CEO', '2026-10-27', 5)$q$),
         'an unconfirmed address signed an intake';
end $$;

select become('dddddddd-0000-0000-0000-00000000000c');
do $$ begin
  assert refused($q$select submit_intake('dddddddd-3333-0000-0000-000000000001',
                    'Jane Doe', 'CEO', '2026-10-27', 4)$q$),
         'an intake was signed with a statement left unaccepted';
  assert refused($q$select submit_intake('dddddddd-3333-0000-0000-000000000001',
                    'Jane Doe', 'CEO', '1999-01-01', 5)$q$),
         'an intake was signed against terms that are not current';
  assert refused($q$select submit_intake('dddddddd-3333-0000-0000-000000000001',
                    ' ', 'CEO', '2026-10-27', 5)$q$),
         'an intake was signed without a name';
end $$;

do $$
declare r jsonb;
begin
  r := submit_intake('dddddddd-3333-0000-0000-000000000001',
                     'Jane Doe', 'CEO', '2026-10-27', 5, 'test-agent');
  -- geo@ once (deduplicated, lower-cased), cfo@ already a member, junk dropped.
  assert (r->>'invited')::int = 1, 'expected exactly one invitation, got ' || r;
  assert (r->>'already_members')::int = 1, 'an existing member was not recognised: ' || r;
end $$;

select unbecome();
do $$
declare a intake_attestations%rowtype;
begin
  select * into a from intake_attestations
   where intake_id = 'dddddddd-3333-0000-0000-000000000001';
  assert found, 'no signed record was written';
  assert a.signer_email = 'ceo@issuer.test', 'the record does not name the signer''s verified address';
  assert a.signer_user_id = 'dddddddd-0000-0000-0000-00000000000c', 'wrong signer id';
  assert a.company_name = 'Issuer Gold Corp', 'company name not captured';
  assert jsonb_array_length(a.statements) = 5, 'statements not captured';
  assert a.statements->>0 like 'I am authorized by Issuer Gold Corp%',
         'the company name was not written into the statements';
  assert jsonb_array_length(a.people) = 2, 'people snapshot wrong: ' || a.people;
  assert jsonb_array_length(a.files) = 1, 'files snapshot wrong';

  assert (select status from intakes where id = 'dddddddd-3333-0000-0000-000000000001') = 'submitted',
         'the intake was not closed';
  assert (select count(*) from invites
           where org_id = 'dddddddd-1111-0000-0000-000000000001'
             and lower(email) = 'geo@issuer.test' and role = 'client'
             and authorized_by = a.id) = 1,
         'the named person was not invited as a client from the signature';
  assert (select count(*) from invites where lower(email) = 'cfo@issuer.test') = 0,
         'an existing member was invited again';
  assert (select count(*) from invites where email = 'not-an-address') = 0,
         'a malformed address was invited';
end $$;

-- ------------------------------------------- after signing ---------------
select become('dddddddd-0000-0000-0000-00000000000c');
do $$ begin
  assert refused($q$select intake_save('dddddddd-3333-0000-0000-000000000001', 'company', '{}')$q$),
         'a client changed an intake after signing it';
  assert refused($q$select submit_intake('dddddddd-3333-0000-0000-000000000001',
                    'Jane Doe', 'CEO', '2026-10-27', 5)$q$),
         'an intake was signed twice';
  assert refused($q$insert into storage.objects (bucket_id, name) values ('intake',
    'dddddddd-1111-0000-0000-000000000001/dddddddd-2222-0000-0000-000000000001/f3/late.csv')$q$),
    'a client uploaded a file after signing';
  -- The signed record is readable to them, and untouchable.
  assert (select count(*) from intake_attestations) = 1, 'the client cannot read what they signed';
  assert refused($q$update intake_attestations set signer_name = 'Someone Else'$q$)
      or (select signer_name from intake_attestations limit 1) = 'Jane Doe',
         'a client edited a signed record';
  assert refused($q$insert into intake_attestations (signer_user_id, signer_email, signer_name,
      signer_title, company_name, project_name, terms_version, statements, people, files, answers)
      values (auth.uid(), 'x@y.z', 'Forged', 'CEO', 'X', 'Y', '2026-10-27', '[]', '[]', '[]', '{}')$q$),
         'a client forged a signed record';
end $$;
delete from intake_files where intake_id = 'dddddddd-3333-0000-0000-000000000001';
do $$ begin
  assert refused($q$delete from intake_attestations$q$)
      or (select count(*) from intake_attestations) = 1,
         'a client deleted a signed record';
end $$;

select unbecome();
do $$ begin
  assert (select count(*) from intake_files
           where intake_id = 'dddddddd-3333-0000-0000-000000000001') = 1,
         'a client deleted a file after signing for it';
  assert (select count(*) from intake_attestations) = 1, 'a client deleted a signed record';
  -- Not even the database owner may rewrite or remove one.
  assert refused($q$update intake_attestations set signer_name = 'Rewritten'$q$),
         'a signed record was rewritten by the service side';
  assert refused($q$delete from intake_attestations$q$),
         'a signed record was deleted by the service side';
end $$;

-- ------------------------------------------- our side reopens it ---------
select become('dddddddd-0000-0000-0000-00000000000a');
update intakes set status = 'open' where id = 'dddddddd-3333-0000-0000-000000000001';
do $$ begin
  assert (select status from intakes where id = 'dddddddd-3333-0000-0000-000000000001') = 'open',
         'staff could not reopen an intake';
end $$;

-- Deleting the project must not take the signed record with it.
delete from projects where id = 'dddddddd-2222-0000-0000-000000000001';
select unbecome();
do $$ begin
  assert (select count(*) from intake_attestations where company_name = 'Issuer Gold Corp') = 1,
         'deleting the project destroyed the signed record';
  assert (select project_id from intake_attestations where company_name = 'Issuer Gold Corp') is null,
         'the record still points at a deleted project';
end $$;

rollback;
