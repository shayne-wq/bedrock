-- Bedrock — gated decks: who asked to see this.
--
-- A deck can require a name and an email before it opens. The viewer that
-- collects them is a PUBLIC, anonymous page, so nothing here is writable by
-- anon: the `lead` edge function runs on the service role, validates the share
-- token first, and inserts. Reading is ordinary org membership — a lead belongs
-- to whoever owns the deck, and to nobody else.
--
-- The gate itself is a per-deck setting (`decks.settings.gate`), not a column:
-- it travels with the deck payload the viewer already fetches.

create table deck_leads (
  id             uuid primary key default gen_random_uuid(),
  deck_id        uuid not null references decks(id) on delete cascade,
  -- Which link they came through, so a campaign can be told from a cold
  -- forward. Kept if the link is later revoked: the lead still happened.
  share_link_id  uuid references share_links(id) on delete set null,
  name           text not null,
  email          text not null,
  company        text,
  -- Same split as view_sessions: host and path, never the query string.
  referrer_host  text,
  referrer_path  text,
  created_at     timestamptz not null default now()
);
create index on deck_leads (deck_id, created_at desc);
create index on deck_leads (share_link_id);

alter table deck_leads enable row level security;
-- Anon gets nothing at all: not select, not insert. The edge function is the
-- only writer, and it is the only thing holding the service role.
revoke all on deck_leads from anon, authenticated;

-- Members of the owning org read them; clients too — a client editing their own
-- deck should see who has been asking about it.
create policy leads_read on deck_leads for select
  using (is_org_member((select p.org_id from decks d
                          join projects p on p.id = d.project_id
                         where d.id = deck_leads.deck_id)));

-- Deleting is an editor's job (a client can read but not destroy), and it is
-- how a viewer's "delete my details" request is answered.
create policy leads_delete on deck_leads for delete
  using (is_org_editor((select p.org_id from decks d
                          join projects p on p.id = d.project_id
                         where d.id = deck_leads.deck_id)));

comment on table deck_leads is
  'Name/email captured by a gated deck. Published retention: 24 months (privacy policy).';

-- Retention, on the same schedule as everything else the policy promises.
-- 24 months, matching the "demo requests and correspondence" line: a lead is a
-- business contact, not an analytics row.
create or replace function public.purge_expired_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_events   integer;
  n_sessions integer;
  n_diag     integer;
  n_invites  integer;
  n_leads    integer;
begin
  delete from public.view_events where at < now() - interval '13 months';
  get diagnostics n_events = row_count;

  delete from public.view_sessions where last_seen_at < now() - interval '13 months';
  get diagnostics n_sessions = row_count;

  delete from public.diag_reports where at < now() - interval '90 days';
  get diagnostics n_diag = row_count;

  delete from public.invites
   where accepted_at is null and expires_at < now() - interval '30 days';
  get diagnostics n_invites = row_count;

  delete from public.deck_leads where created_at < now() - interval '24 months';
  get diagnostics n_leads = row_count;

  return jsonb_build_object('view_events', n_events, 'view_sessions', n_sessions,
                            'diag_reports', n_diag, 'invites', n_invites,
                            'deck_leads', n_leads);
end;
$$;

revoke all on function public.purge_expired_data() from public, anon, authenticated;
