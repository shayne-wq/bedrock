-- Where a project is in its life: discovery, exploration, development, mining.
--
-- Nullable on purpose. Every project that exists today has no stage, and
-- defaulting them all to "exploration" would be this migration asserting
-- something about somebody's asset that nobody told it. An unset stage reads as
-- unset everywhere, and the console asks for it rather than assuming.
--
-- Constrained rather than free text: the four are how the industry talks, and a
-- deck that says "Advanced Exploration" on one project and "advanced expl." on
-- the next cannot be reasoned about. The check is the vocabulary.
alter table projects
  add column if not exists stage text
  check (stage is null or stage in ('discovery','exploration','development','mining'));

comment on column projects.stage is
  'Author''s claim about project maturity. Checked against loaded datasets in '
  'dashboard/lib/stage.js — a stage the data cannot demonstrate is reported in '
  'the console and in the deck audit trail, never blocked.';
