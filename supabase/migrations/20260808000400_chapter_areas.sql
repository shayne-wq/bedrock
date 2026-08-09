-- Presenter annotations, per slide.
--
-- These existed already and lived in localStorage, which meant they were a
-- private scribble: they did not travel with a share link, they did not appear
-- for the audience, and they vanished on another machine. A labelling tool
-- whose labels nobody else sees is not a labelling tool.
--
-- Per CHAPTER rather than per deck, because pointing at the vein on the
-- section slide and pointing at the access road on the site slide are not the
-- same annotation, and showing both on both is how a deck gets noisy.
--
-- Shape: [{ll:[lon,lat,...], color:'#38BDF8', label:'…'}]. lon/lat pairs
-- flattened, WGS84, exactly as the viewer draws and exports them.
alter table chapters add column if not exists areas jsonb not null default '[]'::jsonb;
comment on column chapters.areas is
  'Authored map annotations for this slide. Drawn, not surveyed — the viewer '
  'styles them so they cannot be mistaken for tenure boundaries.';
