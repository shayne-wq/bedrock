-- What this deck shows, and what it does not.
--
-- An issuer will not want every hole on an investor page: a barren step-out
-- that exists to close the anomaly is honest drilling and a distraction on a
-- slide. So a deck can leave holes out.
--
-- Two rules make that a presentation choice rather than a disclosure problem:
--
--  1. It lives on the DECK, not on the dataset and not on the chapter. Not the
--     dataset, because the same project needs an investor deck and a technical
--     deck from one upload. Not the chapter, because then "how many holes does
--     this deck show" has no answer — a reader would have to union every slide
--     to learn what was withheld, which is not something a reader can do. One
--     deck, one boundary, one number in the provenance trail.
--  2. A chapter may narrow within it — `layers.holes` picks which of the
--     INCLUDED holes a slide draws attention to — but may never widen past it.
--     Emphasis is editorial; inclusion is disclosure.
--
-- Named `inclusion`, not `include`: INCLUDE is a reserved word in Postgres and
-- a column called that has to be quoted everywhere, forever.
--
-- Shape:
--   { "holes": { "rule": { "minGm": 5, "minLen": 0 },
--                "hide": ["DDH-12"],      -- always out, whatever the rule says
--                "show": ["DDH-03"] } }   -- always in, whatever the rule says
--
-- The rule proposes and keeps proposing as new drilling arrives; the two lists
-- are the geologist disagreeing with it. A rule alone would eventually hide the
-- step-out that defines the boundary, and a list alone rots the day a new
-- programme lands.
alter table decks
  add column if not exists inclusion jsonb not null default '{}'::jsonb;

comment on column decks.inclusion is
  'Presentation filter: which drill holes this deck shows. Empty means all of '
  'them. Never changes a computed statistic — tonnage and grade come from the '
  'block model, not from the holes — and the count of what is hidden is stated '
  'in the deck''s provenance trail.';
