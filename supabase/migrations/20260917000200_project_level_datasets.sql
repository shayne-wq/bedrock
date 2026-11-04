-- Bedrock — the property is not a zone, and a zone is optional.
--
-- Two things were wrong with where datasets hang.
--
-- ONE. "Property & claims" and topography were loaded PER ZONE. A claim block
-- is registered against the property, not against a deposit: a project with
-- three zones had to upload the same tenure file three times and nothing made
-- the three agree. That file is also what the district slide, the neighbouring
-- ground lookup and the claim colour-pop are all read from, so three copies
-- meant three answers to "where is this company's ground".
--
-- TWO. A zone was mandatory. The console held nothing until one was named, so a
-- company with a single undivided land package — which is most of them early
-- on — had to invent a zone in order to describe a property that has none.
--
-- So: `zone_id is null` now means THE WHOLE PROJECT. site and topography are
-- always project-level; every other kind may sit at either level; and a project
-- with no zones at all carries all of its data at project level.
--
-- Storage paths are deliberately NOT rewritten. A path records where the bytes
-- were actually put, purgeDatasetFiles reads the folder back out of the path
-- itself, and rewriting a path would mean moving objects in a bucket that
-- refuses deletes made from SQL. New project-level uploads write
-- <org>/<project>/_project/<dataset>/, which is still four segments deep, so
-- the purge's "anything shallower than three is a project root" guard holds.

-- Property-wide kinds move off whichever zone they happened to land on.
--
-- Newest wins where a project holds more than one. It cannot today — every
-- project in the database has exactly one site and no topography — but the
-- unique index below would fail the ENTIRE migration on a duplicate rather than
-- the row, and a migration that a single duplicate can defeat is one that runs
-- on this database and never on the next.
with ranked as (
  select id,
         row_number() over (partition by project_id, kind
                            order by created_at desc, id desc) as rn
    from datasets
   where kind in ('site', 'topography')
)
delete from datasets d
 using ranked r
 where d.id = r.id and r.rn > 1;

update datasets
   set zone_id = null
 where kind in ('site', 'topography')
   and zone_id is not null;

-- One dataset of each kind at project level, mirroring the per-zone index this
-- sits beside. Without it the console's replace-then-insert could race into two
-- property boundaries, and the viewer takes whichever the database returns
-- first — the same silent wrong-answer the per-zone index was added to prevent.
create unique index datasets_one_per_kind_per_project
  on datasets (project_id, kind) where zone_id is null;
