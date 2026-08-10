-- Bedrock — fixtures for the edge function integration tests.
--
-- Loaded automatically by `supabase db reset` (config.toml db.seed.sql_paths).
-- Everything here exists to satisfy `supabase/tests/functions_test.sh`, which
-- asserts against these exact ids, titles and the share token below. Change a
-- value here and that suite fails; the two files are a matched pair.
--
-- This is test data for a LOCAL stack. Do not load it into a hosted project:
-- it creates a live, passcode-free share link with a guessable token.
--
-- Seeding runs as the table owner, which bypasses RLS. That is fine — the RLS
-- policies are exercised by rls_test.sql, which becomes each role explicitly.

-- The tenant. The deck payload must never expose this org's id; the "no org id
-- in the payload" assertion is what guards that.
insert into orgs (id, name, slug) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Test Mining Corp', 'test-mining-corp')
on conflict (id) do nothing;

-- functions_test.sh line ~126 inserts a second deck directly against this
-- project id to prove a foreign session is not adopted, so the id is load
-- bearing, not just the name.
insert into projects (id, org_id, name, slug, commodity, location, epsg) values
  ('aaaaaaaa-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'Elk Gold', 'elk-gold', 'Au', 'Nicola region, British Columbia', 26910)
on conflict (id) do nothing;

-- Exactly ONE dataset, deliberately.
--
-- The deck function selects datasets with no ORDER BY, so "assets[0]" is only
-- deterministic while there is a single row. The suite asserts both
-- assets[0].synthetic_note and fabricated[0] == 'drills'; adding a second
-- dataset here makes those two checks flap depending on planner order.
--
-- storage_path points at an object that does not exist in the artifacts
-- bucket. createSignedUrl then returns null rather than throwing, so `url` is
-- null in the payload — which nothing asserts on. Keep it that way unless you
-- are prepared to upload a fixture object too.
insert into datasets (id, project_id, kind, label, storage_path, bytes,
                      stats, provenance, synthetic, synthetic_note) values
  ('aaaaaaaa-0000-0000-0000-00000000000d',
   'aaaaaaaa-0000-0000-0000-000000000002',
   'drills', 'Synthetic drill traces',
   'aaaaaaaa-0000-0000-0000-000000000002/drills.json', 4096,
   '{"holes": 40}'::jsonb,
   -- buckets_path is here on purpose. Every storage path starts with the org
   -- UUID, so provenance is a second route to the tenant id that the deck
   -- function's `project` select deliberately omits. The suite asserts the
   -- *_path keys are scrubbed and that generator survives, so this row is what
   -- keeps that scrub honest.
   '{"generator": "tools/make_synthetic_drills.py",
     "buckets_path": "aaaaaaaa-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-000000000002/aaaaaaaa-0000-0000-0000-00000000000d/buckets.json"}'::jsonb,
   true, 'Fabricated demo holes')
on conflict (id) do nothing;

-- Status must not be 'archived' — the deck function 404s those, which would
-- fail the happy-path assertions before they got anywhere interesting.
insert into decks (id, project_id, title, subtitle, status) values
  ('aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002',
   'Siwash North', 'Nicola region, British Columbia', 'published')
on conflict (id) do nothing;

-- Two chapters, and the suite checks they come back in `ord` order with
-- 'Opening' first — so the ords matter as much as the titles.
insert into chapters (id, deck_id, ord, kind, section, title, body, dwell_ms) values
  ('aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-000000000003', 0, 'scene', 'Introduction',
   'Opening', 'The deposit in regional context.', 9000),
  ('aaaaaaaa-0000-0000-0000-00000000000b',
   'aaaaaaaa-0000-0000-0000-000000000003', 1, 'scene', 'Resource',
   'Grade shells', 'Share-weighted vein tonnage.', 9000)
on conflict (id) do nothing;

-- The share token.
--
-- 32 chars, alphanumeric, on purpose: the share_links_urlsafe BEFORE INSERT
-- trigger rewrites tokens ('+' -> '-', '/' -> '_', trailing '=' stripped). A
-- fixture token containing any of those would be silently stored as something
-- other than what the test sends, and every request would 404 for reasons that
-- look nothing like the real cause.
--
-- The suite mutates this row throughout (revokes it, expires it, sets a
-- passcode, flips allow_embed, pins domains) and resets each one afterwards,
-- so it must start in the fully permissive state below.
insert into share_links (id, deck_id, token, label, allow_embed, domains) values
  ('aaaaaaaa-0000-0000-0000-00000000000c',
   'aaaaaaaa-0000-0000-0000-000000000003',
   'testtoken123456789012345678901234', 'Integration test link',
   true, '{}')
on conflict (id) do nothing;
