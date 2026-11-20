-- Bedrock — telling the people who asked, when the metres move.
--
-- Posting a progress report changes every share link for the project and tells
-- nobody. The leads a gated deck captured are precisely the people who asked to
-- be told, and the published privacy policy says their details are held for the
-- issuer "to follow up" — which this is.
--
-- MAILING IS A THIRD ACT, after writing and after posting. The schema already
-- draws that line once: reading a figure off a file is arithmetic, telling the
-- shareholders of a public company what it is, is disclosure. Broadcasting it
-- to a list of named people is a third decision, and it gets its own record
-- rather than riding on `published_at`.

-- ---------------------------------------------------------- unsubscribe ----
-- CASL requires one, and a list you cannot leave is not a list anybody should
-- be on. The token is per lead so the link carries no id to enumerate and can
-- be used to read nothing at all.
--
-- gen_random_uuid() rather than gen_random_bytes(): it is built in from PG13
-- and needs no extension, and a v4 UUID is 122 bits of randomness, which is
-- more than an unsubscribe link requires.
alter table deck_leads
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists unsub_token text;

update deck_leads set unsub_token = replace(gen_random_uuid()::text, '-', '')
 where unsub_token is null;

alter table deck_leads
  alter column unsub_token set default replace(gen_random_uuid()::text, '-', '');
alter table deck_leads alter column unsub_token set not null;

create unique index if not exists deck_leads_unsub_token_idx
  on deck_leads (unsub_token);

comment on column deck_leads.unsubscribed_at is
  'Set when the lead used the unsubscribe link. Never cleared by us: opting back in is their decision to make again, not ours to undo.';

-- ------------------------------------------------------------- the log -----
-- One row per recipient per report. `unique (update_id, lead_id)` is the whole
-- point: a second press of the button is a no-op because the DATABASE refuses
-- the duplicate, not because the console remembered to check. A send log kept
-- only in application code is a send log that eventually sends twice.
create table if not exists drill_notices (
  id          uuid primary key default gen_random_uuid(),
  update_id   uuid not null references drill_updates(id) on delete cascade,
  lead_id     uuid not null references deck_leads(id) on delete cascade,
  -- Which deck's audience this was, so the figure can be traced to the link it
  -- went out on without joining back through the lead.
  deck_id     uuid not null references decks(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  -- Postmark's own message id, so a bounce enquiry has something to quote.
  provider_id text,
  status      text not null default 'sent'
    check (status in ('sent', 'failed')),
  error       text,
  unique (update_id, lead_id)
);
create index if not exists drill_notices_update_idx on drill_notices (update_id);
create index if not exists drill_notices_deck_idx on drill_notices (deck_id, sent_at desc);

alter table drill_notices enable row level security;

-- The edge function holds the service role and is the only writer. A GRANT is
-- not a POLICY and a POLICY is not a GRANT: both are needed for the read, and
-- the write side is left without either on purpose.
revoke all on drill_notices from anon, authenticated;
grant select on drill_notices to authenticated;

create policy notices_read on drill_notices for select
  using (is_org_member((select p.org_id
                          from decks d
                          join projects p on p.id = d.project_id
                         where d.id = drill_notices.deck_id)));

comment on table drill_notices is
  'One row per lead per drill report mailed. Cascades with the lead, so the 24-month lead retention carries it.';
