-- Which candidate a chapter came from.
--
-- The deck builder matched chapters to candidates BY TITLE, which fails the
-- moment anybody edits a title — the chapter drops out of the running order,
-- and the next Save order deletes it as though it had been removed. A stable
-- key makes the match survive editing, which is the whole point of a builder
-- you are meant to come back to.
--
-- Null for chapters added by hand. They match nothing, which is correct: there
-- is no candidate they could be a copy of.
alter table chapters add column if not exists source text;
comment on column chapters.source is
  'Candidate id this chapter was generated from; null when hand-authored.';
