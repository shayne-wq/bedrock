-- Email open tracking for outbound.
--
-- Deliberately narrow. What is stored is: which share link the message carried,
-- when the pixel was fetched, and the browser/proxy family. NO IP address and
-- no recipient address — the share link already identifies the company, and
-- storing the person's address here would add nothing the CRM does not hold.
--
-- The hard part is not recording an open, it is knowing whether a human caused
-- it. Mail security filters fetch every remote image on delivery, and Apple
-- Mail Privacy Protection pre-fetches for every recipient whether or not the
-- message is ever read. So this table records the RAW fetch and leaves the
-- judgement to the reader: `ua_family` separates Google's image proxy (which
-- fetches on open) from everything else, and the gap between the send and the
-- fetch does the rest.
create table if not exists email_opens (
  id            uuid primary key default gen_random_uuid(),
  share_link_id uuid not null references share_links(id) on delete cascade,
  opened_at     timestamptz not null default now(),
  ua_family     text,
  proxy         text,           -- 'google' | 'apple' | 'microsoft' | null
  created_at    timestamptz not null default now()
);
create index if not exists email_opens_link_idx on email_opens (share_link_id, opened_at);

alter table email_opens enable row level security;

-- No policy for anon or authenticated: the edge function writes with the
-- service role, and nothing in the browser ever reads this.
