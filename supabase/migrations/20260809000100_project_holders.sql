-- Logos for the companies whose ground surrounds a project.
--
-- The neighbouring-asset layer names the registered holders next to a deposit,
-- and a logo is the difference between "Vizsla Copper Corp." — which means
-- nothing to a generalist investor — and a mark they recognise. That is the
-- whole reason the layer earns its place on a slide.
--
-- Supplied, never scraped. A company's mark is its trademark; generating or
-- fetching one for a neighbour would put an identity we invented on a real
-- map, next to real tenure, in front of people making decisions. Absent, the
-- viewer draws a monogram, which is honest about being a placeholder.
--
-- Shape: { "<OWNER NAME AS REGISTERED>": { "logo": "data:image/png;base64,…" } }
-- Keyed on the register's own owner string, upper-cased and space-collapsed by
-- the viewer, so it survives the register's inconsistent spacing.
alter table projects add column if not exists holders jsonb not null default '{}'::jsonb;
comment on column projects.holders is
  'Per-registered-holder presentation overrides — currently a supplied logo. '
  'Keyed on OWNER_NAME from the tenure register.';
