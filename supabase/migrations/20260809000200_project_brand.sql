-- The issuer's own mark and the line that introduces the property.
--
-- The deck's second slide is "this is us, and this is our ground", and it
-- cannot be built from the register: the register knows the company's legal
-- name and nothing else. The logo and the one-paragraph description are the
-- only things on that slide a database cannot derive, so they are stored
-- rather than typed into a chapter body — a chapter can be rewritten or
-- reordered, and this belongs to the project.
--
-- Shape: { "logo": "data:image/png;base64,…", "summary": "…" }
alter table projects add column if not exists brand jsonb not null default '{}'::jsonb;
comment on column projects.brand is
  'Issuer presentation: logo (data URI, downscaled at upload) and a short '
  'property summary used by the opening slides.';
