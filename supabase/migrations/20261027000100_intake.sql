-- Client onboarding: the intake.
--
-- Before this, onboarding a company was an email thread: a questionnaire, a
-- Dropbox link, and a list of who should get access typed into a message. Three
-- problems with that, and this file answers each:
--
-- 1. The answers had to be retyped into the console. Here they are stored
--    against the project they describe (`intakes.answers`).
--
-- 2. Files arrived out of band, and the first anyone learned that a block model
--    was a Vulcan .bmf was a week later. Here the client uploads them directly
--    (`intake_files`, storage bucket `intake`), and the console tells them at
--    upload time what it cannot read.
--
-- 3. Access was granted on our say-so. Who sees a company's unreleased data is
--    the company's decision, and it should be on record as theirs. Here the
--    client names the people, a named person signs a fixed set of statements,
--    and the invitations are created FROM that signature
--    (`intake_attestations`, `invites.authorized_by`). The record is
--    append-only: nobody holding a user token can change or delete it.
--
-- A NOTE ON RAW FILES. `datasets` deliberately never stores a customer's raw
-- block model — extraction happens in their browser and only derivatives are
-- uploaded. Intake files are different in kind: they are what would otherwise
-- have been an email attachment, sent to us on purpose for us to work from. They
-- live in their own private bucket, readable only by members of the issuing
-- org, and are never served to a deck viewer.

-- ------------------------------------------------------------- helpers ----
-- Org of a project, readable regardless of the caller's RLS. DEFINER for the
-- same reason as is_org_member: the policies below call it.
create function project_org(p_project uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from projects where id = p_project;
$$;

-- ------------------------------------------------------------- intakes ----
create table intakes (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null unique references projects(id) on delete cascade,
  -- open: the client is filling it in. submitted: signed and handed to us; the
  -- client can no longer change it. accepted: we have reviewed it.
  status        text not null default 'open'
                  check (status in ('open', 'submitted', 'accepted')),
  -- One key per section of the form. Shape is owned by dashboard/intake.js.
  answers       jsonb not null default '{}'::jsonb,
  submitted_at  timestamptz,
  submitted_by  uuid references auth.users(id) on delete set null,
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null
);

create function intake_org(p_intake uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.org_id from intakes i join projects p on p.id = i.project_id where i.id = p_intake;
$$;

create function intake_open(p_intake uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'open' from intakes where id = p_intake), false);
$$;

create function project_intake_open(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'open' from intakes where project_id = p_project), false);
$$;

alter table intakes enable row level security;

create policy intake_read on intakes for select
  using (is_org_member(project_org(project_id)));

-- A client may open the intake for their own project — the first person to
-- visit the page creates the row — but only as 'open'.
create policy intake_create on intakes for insert
  with check (is_org_member(project_org(project_id)) and status = 'open');

-- Clients edit while it is open; editors (our side) edit any time, which is how
-- an intake is reopened or accepted.
create policy intake_update on intakes for update
  using (is_org_editor(project_org(project_id))
         or (is_org_member(project_org(project_id)) and status = 'open'))
  with check (is_org_editor(project_org(project_id))
              or (is_org_member(project_org(project_id)) and status = 'open'));

create policy intake_delete on intakes for delete
  using (is_org_editor(project_org(project_id)));

-- RLS decides WHICH rows a client may update, not which columns. Without this a
-- client could set status = 'submitted' directly and skip the signature, or
-- rewrite who submitted it. `current_user = 'authenticated'` is the request
-- role; inside submit_intake (SECURITY DEFINER) it is the function owner, which
-- is how the one legitimate transition gets through.
-- SECURITY INVOKER on purpose. A DEFINER trigger sees the function owner as
-- current_user on every request, and the check below silently never fires —
-- which is exactly what the first version of this did.
create function intake_guard() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  if current_user = 'authenticated'
     and not is_org_editor(project_org(old.project_id)) then
    if new.status is distinct from old.status
       or new.project_id is distinct from old.project_id
       or new.submitted_at is distinct from old.submitted_at
       or new.submitted_by is distinct from old.submitted_by
       or new.accepted_at is distinct from old.accepted_at
       or new.accepted_by is distinct from old.accepted_by then
      raise exception 'Only Bedrock can change the status of an intake'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger intakes_guard before update on intakes
  for each row execute function intake_guard();

-- Section-level save. Two people filling in different sections at once must not
-- overwrite each other, which a whole-object update would do. SECURITY INVOKER:
-- this is an UPDATE through the caller's RLS, so a closed intake stays closed.
create function intake_save(p_intake uuid, p_section text, p_value jsonb)
returns timestamptz language plpgsql security invoker set search_path = public as $$
declare v_at timestamptz;
begin
  if p_section !~ '^[a-z_]{1,40}$' then
    raise exception 'Bad section name';
  end if;
  update intakes
     set answers = jsonb_set(answers, array[p_section], coalesce(p_value, 'null'::jsonb), true)
   where id = p_intake
  returning updated_at into v_at;
  if v_at is null then
    raise exception 'This intake is closed or you do not have access to it'
      using errcode = '42501';
  end if;
  return v_at;
end $$;

-- -------------------------------------------------------- intake_files ----
create table intake_files (
  id            uuid primary key default gen_random_uuid(),
  intake_id     uuid not null references intakes(id) on delete cascade,
  -- Which row of the checklist this file answers: 'blocks', 'drills_assays',
  -- 'neighbour_logo', … Free text with a shape, so a new row needs no migration.
  slot          text not null check (slot ~ '^[a-z0-9_:-]{1,64}$'),
  filename      text not null check (length(filename) between 1 and 255),
  storage_path  text not null unique,
  bytes         bigint,
  content_type  text,
  -- What dashboard/lib/formats.js sniff() made of it at upload time, so the
  -- review screen can show what we will have to ask for again.
  format        text,
  readable      boolean,
  -- Free-form: e.g. which neighbour a logo belongs to.
  meta          jsonb not null default '{}'::jsonb,
  uploaded_by   uuid default auth.uid() references auth.users(id) on delete set null,
  uploaded_at   timestamptz not null default now()
);
create index on intake_files (intake_id, slot);

alter table intake_files enable row level security;

create policy intake_file_read on intake_files for select
  using (is_org_member(intake_org(intake_id)));

-- Uploaded as yourself, into your own org's folder, while the intake is open.
create policy intake_file_add on intake_files for insert
  with check (
    is_org_member(intake_org(intake_id))
    and uploaded_by = auth.uid()
    and split_part(storage_path, '/', 1) = intake_org(intake_id)::text
    and (intake_open(intake_id) or is_org_editor(intake_org(intake_id))));

-- You can take back your own upload while the intake is open. After it is
-- signed, the files are part of what was signed for.
create policy intake_file_remove on intake_files for delete
  using ((uploaded_by = auth.uid() and intake_open(intake_id))
         or is_org_editor(intake_org(intake_id)));

-- -------------------------------------------------------------- storage ----
-- Private. 5 GB per file at the bucket level; the project-wide upload limit in
-- Supabase settings must be raised to match, or it caps first.
insert into storage.buckets (id, name, public, file_size_limit)
values ('intake', 'intake', false, 5368709120)
on conflict (id) do nothing;

-- Path: <org_id>/<project_id>/<file_id>/<filename>. The first segment is the
-- tenant boundary, the second must be a project of that org.
create policy intake_obj_read on storage.objects for select
  using (bucket_id = 'intake'
         and is_org_member(((storage.foldername(name))[1])::uuid));

create policy intake_obj_write on storage.objects for insert
  with check (bucket_id = 'intake'
              and is_org_member(((storage.foldername(name))[1])::uuid)
              and project_org(((storage.foldername(name))[2])::uuid)
                  = ((storage.foldername(name))[1])::uuid
              and (project_intake_open(((storage.foldername(name))[2])::uuid)
                   or is_org_editor(((storage.foldername(name))[1])::uuid)));

-- No update policy: a sent file is never overwritten in place. Replace means
-- upload a new one and remove the old.
create policy intake_obj_delete on storage.objects for delete
  using (bucket_id = 'intake'
         and ((owner = auth.uid()
               and project_intake_open(((storage.foldername(name))[2])::uuid))
              or is_org_editor(((storage.foldername(name))[1])::uuid)));

-- ---------------------------------------------------------- the wording ----
-- The statements a signer agrees to live HERE, not in the console. The console
-- shows them; the database records them. If the text came from the browser, a
-- signature would only prove that somebody's browser sent some words.
--
-- Versioned and never edited: a change of wording is a new row, so every past
-- signature still points at exactly what was agreed. `{company}` is replaced
-- with the organisation's name at signing.
create table intake_terms (
  version     text primary key,
  statements  jsonb not null check (jsonb_typeof(statements) = 'array'
                                    and jsonb_array_length(statements) > 0),
  current     boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index intake_terms_one_current on intake_terms (current) where current;

alter table intake_terms enable row level security;
create policy intake_terms_read on intake_terms for select using (auth.uid() is not null);

insert into intake_terms (version, current, statements) values ('2026-10-27', true, jsonb_build_array(
  'I am authorized by {company} to provide this information and these files to Bedrock, and to decide who may access them.',
  '{company} owns this data or has the right to share it and to have it shown in investor materials. Anything from third parties that we included, such as information on neighbouring properties, is publicly available.',
  'I have identified anything confidential or not yet publicly disclosed. {company} is responsible for making sure nothing is published before it has been disclosed in accordance with applicable securities rules.',
  'Bedrock gives access to this project only to the people {company} lists in this intake. Each person listed may see all of the project''s data and edit its decks. {company} will tell Bedrock when someone''s access should end.',
  'Technical information will be reviewed by {company}''s Qualified Person before it is published. Bedrock presents the data as provided and does not verify, audit or certify it.'
));

-- --------------------------------------------------------- attestations ----
-- The signed record. A snapshot of everything that was true at the moment of
-- signing — who, what they agreed to, which people they named, which files they
-- had sent and what they had answered — so it still reads correctly after the
-- project is edited, renamed or deleted.
create table intake_attestations (
  id                uuid primary key default gen_random_uuid(),
  -- Nullable and SET NULL: the record outlives the project it was about.
  org_id            uuid references orgs(id) on delete set null,
  project_id        uuid references projects(id) on delete set null,
  intake_id         uuid references intakes(id) on delete set null,
  signer_user_id    uuid not null,
  signer_email      text not null,
  signer_name       text not null check (length(trim(signer_name)) between 2 and 160),
  signer_title      text not null check (length(trim(signer_title)) between 2 and 160),
  company_name      text not null,
  project_name      text not null,
  terms_version     text not null references intake_terms(version),
  statements        jsonb not null,
  people            jsonb not null,
  files             jsonb not null,
  answers           jsonb not null,
  user_agent        text,
  signed_at         timestamptz not null default now()
);
create index on intake_attestations (org_id, signed_at desc);
create index on intake_attestations (intake_id);

alter table intake_attestations enable row level security;
create policy attestation_read on intake_attestations for select
  using (org_id is not null and is_org_member(org_id));
-- No insert, update or delete policy: rows are written by submit_intake only.
revoke insert, update, delete on intake_attestations from anon, authenticated;

-- Append-only, for every role including the service role. The one change
-- allowed is the foreign keys going to NULL when what they point at is deleted.
create function attestation_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Signed intake records cannot be deleted';
  end if;
  if (to_jsonb(new) - array['org_id','project_id','intake_id'])
       is distinct from (to_jsonb(old) - array['org_id','project_id','intake_id'])
     or (new.org_id is not null and new.org_id is distinct from old.org_id)
     or (new.project_id is not null and new.project_id is distinct from old.project_id)
     or (new.intake_id is not null and new.intake_id is distinct from old.intake_id) then
    raise exception 'Signed intake records cannot be changed';
  end if;
  return new;
end $$;
create trigger attestations_immutable before update or delete on intake_attestations
  for each row execute function attestation_immutable();

-- Which signature an invitation came from. NULL for invitations an admin made
-- by hand in the People page.
alter table invites add column if not exists authorized_by uuid
  references intake_attestations(id) on delete set null;

-- --------------------------------------------------------------- submit ----
-- Sign and submit. DEFINER because it does three things a client cannot do
-- directly, and must do them together or not at all: write the signed record,
-- close the intake, and create invitations for the people named in it.
--
-- Everything that identifies the signer comes from the session and auth.users,
-- never from arguments. The name and title are typed by them; that is the
-- point of a signature.
create function submit_intake(
  p_intake      uuid,
  p_signer_name text,
  p_signer_title text,
  p_terms_version text,
  p_accepted    integer,
  p_user_agent  text default null
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_ok      boolean;
  v_in      intakes%rowtype;
  v_proj    projects%rowtype;
  v_org     orgs%rowtype;
  v_terms   intake_terms%rowtype;
  v_stmts   jsonb;
  v_people  jsonb;
  v_files   jsonb;
  v_att     uuid;
  v_invited integer := 0;
  v_member  integer := 0;
  p         jsonb;
  e         text;
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  select * into v_in from intakes where id = p_intake for update;
  if not found then raise exception 'No such intake'; end if;
  select * into v_proj from projects where id = v_in.project_id;
  select * into v_org from orgs where id = v_proj.org_id;

  if not is_org_member(v_org.id) then
    raise exception 'You are not a member of this organisation' using errcode = '42501';
  end if;
  if v_in.status <> 'open' then
    raise exception 'This intake has already been submitted';
  end if;

  select lower(u.email), u.email_confirmed_at is not null
    into v_email, v_ok from auth.users u where u.id = v_uid;
  if not coalesce(v_ok, false) then
    raise exception 'Confirm your email address before signing' using errcode = '42501';
  end if;

  select * into v_terms from intake_terms where version = p_terms_version;
  if not found or not v_terms.current then
    raise exception 'The terms have changed since this page loaded. Reload and read them again.';
  end if;
  -- Agreeing to some of the statements is not agreeing.
  if p_accepted is distinct from jsonb_array_length(v_terms.statements) then
    raise exception 'Every statement must be accepted';
  end if;
  if length(trim(coalesce(p_signer_name, ''))) < 2
     or length(trim(coalesce(p_signer_title, ''))) < 2 then
    raise exception 'Type your full name and title to sign';
  end if;

  select coalesce(jsonb_agg(to_jsonb(replace(s, '{company}', v_org.name))), '[]'::jsonb)
    into v_stmts from jsonb_array_elements_text(v_terms.statements) s;

  -- The people named, cleaned: valid addresses only, one row per address.
  select coalesce(jsonb_agg(x order by x->>'email'), '[]'::jsonb) into v_people from (
    select distinct on (lower(trim(q->>'email')))
           jsonb_build_object(
             'name',  left(trim(coalesce(q->>'name', '')), 160),
             'email', lower(trim(q->>'email')),
             'title', left(trim(coalesce(q->>'title', '')), 160)) x
      from jsonb_array_elements(coalesce(v_in.answers #> '{access,people}', '[]'::jsonb)) q
     where jsonb_typeof(q) = 'object'
       and lower(trim(q->>'email')) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ) t;
  if jsonb_array_length(v_people) > 50 then
    raise exception 'At most 50 people per intake — contact Bedrock for more';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slot', f.slot, 'filename', f.filename, 'bytes', f.bytes,
           'storage_path', f.storage_path, 'format', f.format,
           'uploaded_at', f.uploaded_at) order by f.slot, f.uploaded_at), '[]'::jsonb)
    into v_files from intake_files f where f.intake_id = v_in.id;

  insert into intake_attestations (org_id, project_id, intake_id, signer_user_id,
    signer_email, signer_name, signer_title, company_name, project_name,
    terms_version, statements, people, files, answers, user_agent)
  values (v_org.id, v_proj.id, v_in.id, v_uid, v_email, trim(p_signer_name),
    trim(p_signer_title), v_org.name, v_proj.name, v_terms.version, v_stmts,
    v_people, v_files, v_in.answers, left(p_user_agent, 400))
  returning id into v_att;

  -- One invitation per named person who is not already in the org. Role is
  -- always 'client': the intake can let people in, it cannot hand out the
  -- power to delete data or manage access.
  for p in select * from jsonb_array_elements(v_people) loop
    e := p->>'email';
    if exists (select 1 from org_members m join auth.users u on u.id = m.user_id
                where m.org_id = v_org.id and lower(u.email) = e) then
      v_member := v_member + 1;
      continue;
    end if;
    insert into invites (org_id, email, role, invited_by, authorized_by)
    values (v_org.id, e, 'client', v_uid, v_att)
    on conflict (org_id, lower(email)) where accepted_at is null
    do update set authorized_by = coalesce(invites.authorized_by, excluded.authorized_by);
    v_invited := v_invited + 1;
  end loop;

  update intakes set status = 'submitted', submitted_at = now(), submitted_by = v_uid
   where id = v_in.id;

  return jsonb_build_object('attestation', v_att, 'invited', v_invited,
                            'already_members', v_member);
end $$;

revoke all on function submit_intake(uuid, text, text, text, integer, text) from public;
grant execute on function submit_intake(uuid, text, text, text, integer, text) to authenticated;

comment on function submit_intake is
  'Sign an intake: records an append-only attestation, invites the people it names as clients, and closes it.';

-- The helpers are for policies and signed-in callers. Nothing here is useful
-- to an anonymous visitor, so nothing here is callable by one.
revoke execute on function project_org(uuid), intake_org(uuid), intake_open(uuid),
  project_intake_open(uuid), intake_save(uuid, text, jsonb) from public, anon;
grant execute on function project_org(uuid), intake_org(uuid), intake_open(uuid),
  project_intake_open(uuid), intake_save(uuid, text, jsonb) to authenticated;
