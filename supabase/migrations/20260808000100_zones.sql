-- Bedrock — zones.
--
-- A project used to hold exactly one deposit: datasets attached straight to the
-- project, keyed (project_id, kind), and the app deleted-then-inserted to keep
-- one of each. Real properties have more than one zone (Siwash North, Siwash
-- South, …), and the viewer already carries a deposit switcher — so the data
-- model is what was one-deposit-shaped, not the product.
--
-- This inserts a zone between a project and its datasets. A project owns one or
-- more zones; a zone owns the block model, surfaces, drills, site and
-- geophysics that describe that one deposit; a single deck spans whatever zones
-- its project holds. Datasets keep their project_id (every RLS policy and
-- storage path already reads it), and gain a zone_id.

-- (The 'geophysics' dataset kind is added in the migration immediately before
-- this one — a new enum value cannot be added and used in the same transaction,
-- so it lives in its own file.)

-- ------------------------------------------------------------------ zones ---
create table zones (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 160),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  -- Display order, so a presenter can put the flagship zone first.
  ord         integer not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (project_id, slug)
);
create index on zones (project_id, ord);

-- Datasets move under a zone. Nullable for the length of the backfill below,
-- then every existing row carries one and the app always sets it on insert.
alter table datasets add column zone_id uuid references zones(id) on delete cascade;

-- Backfill: every project that already has datasets gets one default zone named
-- after the project — the single-deposit history reads as "that project's one
-- zone" rather than an orphan — and its datasets move onto it.
do $$
declare pr record; z uuid;
begin
  for pr in
    select distinct p.id, p.name
      from projects p
      join datasets d on d.project_id = p.id
     where d.zone_id is null
  loop
    insert into zones (project_id, name, slug, ord)
      values (pr.id, pr.name, 'main', 0)
      returning id into z;
    update datasets set zone_id = z
      where project_id = pr.id and zone_id is null;
  end loop;
end $$;

-- One dataset of each kind per zone: the console replaces rather than
-- accumulates, and two block models in one zone would let a deck read a stale
-- tonnage. Partial so any legacy row that somehow still lacks a zone does not
-- trip the constraint.
create unique index datasets_one_per_kind_per_zone
  on datasets (zone_id, kind) where zone_id is not null;

-- ------------------------------------------------------------------- RLS ----
-- Same shape as every other table: reachable exactly when you are a member of
-- the org that owns the project the zone belongs to.
alter table zones enable row level security;

create policy zone_all on zones for all
  using (exists (select 1 from projects p
                  where p.id = project_id and is_org_member(p.org_id)))
  with check (exists (select 1 from projects p
                       where p.id = project_id and is_org_member(p.org_id)));
