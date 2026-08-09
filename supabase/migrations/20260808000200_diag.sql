-- Orebody — boot failure reports.
--
-- Three rounds of mobile fixes produced no change in symptom, and no
-- diagnostic ever reached me: reading a stack off a phone and retyping it is
-- not a reasonable thing to ask, and a "copy diagnostics" button still needs
-- someone to press it and paste it somewhere. So the page reports its own
-- failure.
--
-- Scope is deliberately narrow. This fires ONLY when a deck fails to open or
-- stalls past the watchdog — never on a successful load — and it carries what
-- is needed to reproduce a rendering failure and nothing else: the boot phase,
-- the error, the user agent, screen geometry and whether WebGL exists. No
-- cookies, no identifier, no IP (Postgres never sees one), no deck contents.
create table diag_reports (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  phase       text,
  message     text,
  stack       text,
  ua          text,
  screen      text,
  dpr         numeric,
  webgl       text,
  online      boolean,
  memory_gb   numeric,
  href        text,
  build       text
);

-- Anonymous viewers must be able to write one and read none. A failure report
-- is not a public log, and being able to read it back would make this an
-- open collection of who is looking at which deck from what device.
alter table diag_reports enable row level security;
revoke all on diag_reports from anon, authenticated;

-- Keep it small on its own. A diagnostic table nobody prunes becomes the
-- largest thing in the database within a year.
create index diag_reports_at_idx on diag_reports (at desc);
