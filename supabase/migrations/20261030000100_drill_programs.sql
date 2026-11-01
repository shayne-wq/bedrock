-- Bedrock — drilling programs, and the progress an issuer reports against one.
--
-- Everything else in this schema describes rock that has already been measured:
-- a block model, an assay, a tenure boundary. A drilling program is the one
-- thing in a mining deck that is still HAPPENING, and it is the thing a
-- shareholder checks most often — "are they turning, and how far through are
-- they?" Today that answer lives in a news release and nowhere in the deck, so
-- the deck ages the moment it is published.
--
-- Two tables, and the split between them is the whole design:
--
--   drill_programs   what was committed to — the plan. Metres, holes, dates,
--                    and where the rig stands. Edited rarely.
--   drill_updates    what has happened since. Append-only in practice: one
--                    dated row per report, each carrying the CUMULATIVE metres
--                    to date rather than the metres since last time.
--
-- Cumulative, not a delta, for two reasons. The number a shareholder repeats is
-- "4,012 m to date", so storing it is storing the thing being claimed rather
-- than a quantity it has to be derived from. And a wrong delta poisons every
-- figure after it — correcting a typo would mean rewriting history — whereas a
-- wrong total is wrong once, visibly, and the next report supersedes it. The
-- console shows the delta it computes (+412 m since Oct 24) so a fat-fingered
-- total is obvious before it is posted.
--
-- PUBLISHING IS A SEPARATE ACT from writing. `published_at` is null until the
-- issuer posts it, and the deck function only ever selects published rows.
-- These numbers go to shareholders of a public company; a half-typed figure
-- must not be visible for the seconds before it is finished, and a draft is
-- how a geologist prepares one for whoever actually signs off on disclosure.

-- ------------------------------------------------------------- programs ----
create type drill_program_status as enum ('planned', 'active', 'paused', 'complete');

create table drill_programs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  -- Null means the whole project, exactly as it does on datasets: a program is
  -- often drilled across a property before anyone has named a zone in it.
  zone_id        uuid references zones(id) on delete set null,
  name           text not null check (length(trim(name)) between 1 and 120),
  status         drill_program_status not null default 'active',
  -- The plan. All optional: a program can be announced before the metres are
  -- budgeted, and a progress bar with no denominator is still a metre count.
  target_m       numeric(10,1) check (target_m is null or target_m > 0),
  holes_planned  integer check (holes_planned is null or holes_planned > 0),
  started_on     date,
  expected_end   date,
  -- Where the rig stands, in the PROJECT's own grid (projects.epsg) — the same
  -- convention deck targets use, and the coordinates a geologist reads off a
  -- collar sheet. Both or neither: half a position is a pin in the sea.
  easting        double precision,
  northing       double precision,
  elev_m         double precision,
  operator       text check (operator is null or length(operator) <= 120),
  note           text check (note is null or length(note) <= 400),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  constraint drill_programs_position_whole
    check ((easting is null) = (northing is null)),
  constraint drill_programs_dates_ordered
    check (expected_end is null or started_on is null or expected_end >= started_on)
);
create index on drill_programs (project_id);
create index on drill_programs (zone_id);

comment on table drill_programs is
  'A drilling campaign: what was committed to, and where the rig stands. Progress is reported in drill_updates.';
comment on column drill_programs.easting is
  'Rig/pad position in the project''s own grid (projects.epsg). Null means the deck shows no marker rather than guessing one.';

-- -------------------------------------------------------------- updates ----
create table drill_updates (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references drill_programs(id) on delete cascade,
  as_of         date not null default current_date,
  -- CUMULATIVE metres drilled by as_of. See the header.
  metres_total  numeric(10,1) check (metres_total is null or metres_total >= 0),
  holes_done    integer check (holes_done is null or holes_done >= 0),
  holes_active  integer check (holes_active is null or holes_active >= 0),
  body          text check (body is null or length(body) <= 2000),
  -- A typed display name ("Mark Fields, VP Exploration"), never an address.
  -- The deck is read by anonymous investors and an email in that payload is a
  -- harvested email. created_by keeps the audit trail on this side of the wire.
  author        text check (author is null or length(author) <= 120),
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);
create index on drill_updates (program_id, as_of desc);
create index on drill_updates (program_id) where published_at is not null;

comment on table drill_updates is
  'One dated progress report against a program. metres_total is cumulative. Null published_at is a draft and never reaches a viewer.';

-- Posting against a program is a change to the program as far as a reader is
-- concerned, so the parent's updated_at follows — same reason chapters touch
-- their deck.
-- search_path pinned. A trigger function that resolves `drill_programs`
-- through whatever search_path the caller happens to carry is resolvable to
-- somebody else's table; the linter flags it, and the older touch_deck above
-- is the reason it is worth saying rather than copying.
create function touch_drill_program() returns trigger
language plpgsql set search_path = public as $$
begin
  update drill_programs set updated_at = now()
   where id = coalesce(new.program_id, old.program_id);
  return null;
end $$;

create trigger drill_updates_touch_program
  after insert or update or delete on drill_updates
  for each row execute function touch_drill_program();

-- ------------------------------------------------------------------ RLS ----
-- Reads at member, writes at member too — and that is deliberate rather than
-- lax. Reporting progress IS the client's job, the same exception chapters
-- take: the people who know the rig turned 412 m yesterday are the issuer's
-- geologists, not us, and a workflow that routes a daily number through the
-- vendor is a workflow that stops being used in a week.
--
-- Deleting the PROGRAM is the one destructive act here — it takes every report
-- filed against it — so that stays with an editor.
alter table drill_programs enable row level security;
alter table drill_updates  enable row level security;

create policy drill_program_read on drill_programs for select
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)));
create policy drill_program_insert on drill_programs for insert
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_member(p.org_id)));
create policy drill_program_update on drill_programs for update
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)))
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_member(p.org_id)));
create policy drill_program_delete on drill_programs for delete
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_editor(p.org_id)));

-- An update is a post. The issuer who filed a wrong number must be able to
-- retract it without asking us, so delete sits at member here.
create policy drill_update_all on drill_updates for all
  using (exists (select 1 from drill_programs g join projects p on p.id = g.project_id
                  where g.id = program_id and is_org_member(p.org_id)))
  with check (exists (select 1 from drill_programs g join projects p on p.id = g.project_id
                       where g.id = program_id and is_org_member(p.org_id)));

-- A policy decides which rows; a grant decides whether the role may ask at all.
-- Supabase's defaults usually cover this, and "usually" is how a table ends up
-- readable everywhere but in production.
grant select, insert, update, delete on drill_programs to authenticated;
grant select, insert, update, delete on drill_updates  to authenticated;
-- Nothing to anon. An anonymous viewer reaches a program only through the deck
-- function, on the service role, filtered to published rows.
