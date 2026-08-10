-- Bedrock — core schema.
--
-- Multi-tenant: an org owns projects, a project owns datasets and decks, a deck
-- owns chapters and share links, and a share link is what a viewer actually
-- opens. Analytics hang off the session, not off a user, because the people we
-- most want to measure are anonymous investors on someone else's website.
--
-- Everything is RLS-denied by default. Two escape hatches, both deliberate:
--   * SECURITY DEFINER helpers for membership checks, so a policy on
--     org_members never queries org_members through RLS (infinite recursion).
--   * The service role, used only by edge functions, which is how anonymous
--     viewers read a shared deck and write analytics without ever being handed
--     SELECT on the underlying tables.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- orgs -----
create type org_role as enum ('owner', 'admin', 'member');

create table orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  slug        text not null unique
                check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  created_at  timestamptz not null default now()
);

create table org_members (
  org_id   uuid not null references orgs(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  role     org_role not null default 'member',
  added_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on org_members (user_id);

-- Membership helpers. SECURITY DEFINER so they read org_members with RLS
-- bypassed — a policy ON org_members that queries org_members through RLS
-- recurses forever, which is the single most common way to brick a Supabase
-- schema. search_path is pinned so the definer right cannot be redirected.
create function is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members
                  where org_id = p_org and user_id = auth.uid());
$$;

create function is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members
                  where org_id = p_org and user_id = auth.uid()
                    and role in ('owner', 'admin'));
$$;

-- ------------------------------------------------------------ projects -----
create table projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 160),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  commodity   text,
  location    text,
  -- Source projection. Everything is stored in its native CRS and reprojected
  -- in the viewer; storing WGS84 would throw away precision we cannot recover.
  epsg        integer not null default 26910,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);
create index on projects (org_id);

-- ------------------------------------------------------------ datasets -----
-- One row per derived artifact. The customer's raw block model is NOT stored:
-- extraction happens in their browser and only the compact derivatives are
-- uploaded. `stats` carries the exact grade-tonnage rollups the viewer reports
-- from, so reporting never depends on what got rendered.
create type dataset_kind as enum ('blocks', 'surfaces', 'drills', 'site');

create table datasets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  kind          dataset_kind not null,
  label         text,
  storage_path  text not null,
  bytes         bigint,
  stats         jsonb not null default '{}'::jsonb,
  provenance    jsonb not null default '{}'::jsonb,
  -- Fabricated data must be able to travel with a flag attached. The viewer
  -- refuses to render a synthetic dataset without a banner, and exports burn
  -- the disclaimer in, so this column is load-bearing, not decorative.
  synthetic     boolean not null default false,
  synthetic_note text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index on datasets (project_id, kind);
alter table datasets add constraint synthetic_must_explain
  check (not synthetic or coalesce(length(trim(synthetic_note)), 0) > 0);

-- --------------------------------------------------------------- decks -----
create type deck_status as enum ('draft', 'published', 'archived');

create table decks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  title       text not null check (length(trim(title)) between 1 and 200),
  subtitle    text,
  status      deck_status not null default 'draft',
  theme       jsonb not null default '{}'::jsonb,
  -- Deck-wide defaults: cut-off, colour mode, which datasets are in play.
  settings    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on decks (project_id);

create type chapter_kind as enum ('scene', 'slide', 'chart');

create table chapters (
  id       uuid primary key default gen_random_uuid(),
  deck_id  uuid not null references decks(id) on delete cascade,
  ord      integer not null,
  kind     chapter_kind not null default 'scene',
  section  text,
  title    text,
  body     text,
  -- Camera pose and layer state, captured from the live viewer rather than
  -- typed: the editor flies you somewhere, you press "capture", and this is
  -- what it stores.
  camera   jsonb not null default '{}'::jsonb,
  layers   jsonb not null default '{}'::jsonb,
  slide    jsonb,
  dwell_ms integer not null default 9000 check (dwell_ms between 1000 and 120000),
  unique (deck_id, ord) deferrable initially deferred
);
create index on chapters (deck_id, ord);

create function touch_deck() returns trigger language plpgsql as $$
begin
  update decks set updated_at = now()
   where id = coalesce(new.deck_id, old.deck_id);
  return coalesce(new, old);
end $$;
create trigger chapters_touch_deck
  after insert or update or delete on chapters
  for each row execute function touch_deck();

-- --------------------------------------------------------- share links -----
-- The token is what lands in an iframe src on a customer's website, so it is
-- the security boundary. Random 32 bytes, revocable, optionally expiring,
-- optionally passcoded, optionally pinned to the domains allowed to frame it.
create table share_links (
  id            uuid primary key default gen_random_uuid(),
  deck_id       uuid not null references decks(id) on delete cascade,
  -- Schema-qualified: pgcrypto lives in `extensions`, which is on the search_path
  -- locally but not for the role that applies migrations on hosted Supabase.
  -- Qualifying also pins the stored default, so an INSERT resolves it whatever
  -- search_path the inserting role happens to carry.
  token         text not null unique default encode(extensions.gen_random_bytes(24), 'base64'),
  label         text,
  expires_at    timestamptz,
  passcode_hash text,
  allow_embed   boolean not null default true,
  -- Empty means "any site". Populated means the edge function refuses to serve
  -- the deck to a referrer outside the list.
  domains       text[] not null default '{}',
  revoked_at    timestamptz,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index on share_links (deck_id);

-- base64 of 24 random bytes contains + and / which are legal in a query string
-- but ugly and easy to mangle when pasted. Normalise to url-safe on write.
create function urlsafe_token() returns trigger language plpgsql as $$
begin
  new.token := replace(replace(trim(trailing '=' from new.token), '+', '-'), '/', '_');
  return new;
end $$;
create trigger share_links_urlsafe
  before insert on share_links
  for each row execute function urlsafe_token();

-- ----------------------------------------------------------- analytics -----
-- Deliberately free of personal data. No IP is stored — the edge function
-- resolves a country and discards the address. No cookies, no cross-site id:
-- `session` is random per browser tab. The referrer is split into host and
-- path with the query string dropped, because "which page embedded us" is the
-- question IR teams ask and "who is this person" is not one we want to answer.
create table view_sessions (
  id             uuid primary key default gen_random_uuid(),
  deck_id        uuid not null references decks(id) on delete cascade,
  share_link_id  uuid references share_links(id) on delete set null,
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- Wall-clock ms the deck was actually open and visible, accumulated by the
  -- viewer. Not (last_seen - started), which counts a forgotten tab.
  watch_ms       integer not null default 0,
  chapters_seen  integer not null default 0,
  completed      boolean not null default false,
  is_embed       boolean not null default false,
  referrer_host  text,
  referrer_path  text,
  country        text,
  device         text,
  browser        text
);
create index on view_sessions (deck_id, started_at desc);
create index on view_sessions (share_link_id);

create table view_events (
  id           bigserial primary key,
  session_id   uuid not null references view_sessions(id) on delete cascade,
  deck_id      uuid not null references decks(id) on delete cascade,
  at           timestamptz not null default now(),
  -- ms since the session started, so a deck's engagement curve can be drawn
  -- without depending on clock skew between viewer and server.
  t_ms         integer not null default 0,
  kind         text not null,
  chapter_ord  integer,
  dwell_ms     integer,
  meta         jsonb not null default '{}'::jsonb
);
create index on view_events (deck_id, at desc);
create index on view_events (session_id);
create index on view_events (deck_id, kind);

-- ----------------------------------------------------------------- RLS -----
alter table orgs          enable row level security;
alter table org_members   enable row level security;
alter table projects      enable row level security;
alter table datasets      enable row level security;
alter table decks         enable row level security;
alter table chapters      enable row level security;
alter table share_links   enable row level security;
alter table view_sessions enable row level security;
alter table view_events   enable row level security;

create policy org_read on orgs for select using (is_org_member(id));
create policy org_write on orgs for update using (is_org_admin(id));
-- Anyone signed in may create an org; the trigger below makes them its owner.
create policy org_create on orgs for insert with check (auth.uid() is not null);

create policy member_read on org_members for select using (is_org_member(org_id));
create policy member_manage on org_members for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));

create policy project_read on projects for select using (is_org_member(org_id));
create policy project_write on projects for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Child tables inherit access by walking up to the org. EXISTS rather than a
-- join so the planner can use the primary key index.
create policy dataset_all on datasets for all
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)))
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_member(p.org_id)));

create policy deck_all on decks for all
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)))
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_member(p.org_id)));

create policy chapter_all on chapters for all
  using (exists (select 1 from decks d join projects p on p.id = d.project_id
                  where d.id = deck_id and is_org_member(p.org_id)))
  with check (exists (select 1 from decks d join projects p on p.id = d.project_id
                       where d.id = deck_id and is_org_member(p.org_id)));

create policy share_all on share_links for all
  using (exists (select 1 from decks d join projects p on p.id = d.project_id
                  where d.id = deck_id and is_org_member(p.org_id)))
  with check (exists (select 1 from decks d join projects p on p.id = d.project_id
                       where d.id = deck_id and is_org_member(p.org_id)));

-- Analytics are readable by the org and writable by nobody holding a user JWT.
-- Viewers are anonymous and write through the edge function on the service
-- role, which bypasses RLS — so there is no policy here that would let a
-- visitor forge engagement for a deck they can see.
create policy session_read on view_sessions for select
  using (exists (select 1 from decks d join projects p on p.id = d.project_id
                  where d.id = deck_id and is_org_member(p.org_id)));

create policy event_read on view_events for select
  using (exists (select 1 from decks d join projects p on p.id = d.project_id
                  where d.id = deck_id and is_org_member(p.org_id)));

-- ------------------------------------------------- org bootstrap -----------
-- Creating an org must make you its owner in the same transaction, or you
-- immediately lose access to the row you just inserted.
create function claim_new_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into org_members (org_id, user_id, role)
  values (new.id, auth.uid(), 'owner')
  on conflict do nothing;
  return new;
end $$;
create trigger orgs_claim after insert on orgs
  for each row when (auth.uid() is not null)
  execute function claim_new_org();
