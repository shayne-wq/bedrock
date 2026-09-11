-- A second camera, for when the deck is read on a phone held upright.
--
-- A shot framed for 16:9 is rarely the shot for 9:16: the subject sits in a
-- different part of the frame, the caption card takes far more of the glass,
-- and the range that showed the whole zone in landscape crops it in portrait.
-- Until now one camera served both, so every deck was framed for whichever
-- shape its author happened to be looking at.
--
-- Nullable and empty by default, and the viewer falls back to `camera` when it
-- is empty — which is what every chapter written to date does, so nothing
-- changes for a deck nobody has framed for portrait.
alter table chapters
  add column if not exists camera_portrait jsonb not null default '{}'::jsonb;

comment on column chapters.camera_portrait is
  'Optional 9:16 framing. Same shape as camera. Empty means "use camera".';
