-- Bedrock — retention, so the privacy policy describes what the database does.
--
-- Until now nothing was ever deleted on a schedule: viewer analytics, failure
-- reports and never-accepted invitations (email addresses of people who are not
-- users) accumulated forever. The published policy at /privacy/ commits to the
-- windows below. Change a number here and the policy must change with it.
--
--   view_sessions / view_events   13 months  (a year-over-year comparison, no more)
--   diag_reports                  90 days
--   invites, never accepted       30 days after they expired

create extension if not exists pg_cron;

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
begin
  delete from public.view_events where at < now() - interval '13 months';
  get diagnostics n_events = row_count;

  -- Cascades to any remaining events of the session. last_seen_at, not
  -- started_at, so a session is never cut away from its own later events.
  delete from public.view_sessions where last_seen_at < now() - interval '13 months';
  get diagnostics n_sessions = row_count;

  delete from public.diag_reports where at < now() - interval '90 days';
  get diagnostics n_diag = row_count;

  delete from public.invites
   where accepted_at is null and expires_at < now() - interval '30 days';
  get diagnostics n_invites = row_count;

  return jsonb_build_object('view_events', n_events, 'view_sessions', n_sessions,
                            'diag_reports', n_diag, 'invites', n_invites);
end;
$$;

comment on function public.purge_expired_data() is
  'Deletes rows past the retention windows published in the privacy policy. Run daily by pg_cron.';

-- Definer, so nobody but the scheduler and the service role may call it.
revoke all on function public.purge_expired_data() from public, anon, authenticated;

-- Idempotent: re-running the migration replaces the job rather than adding a second.
select cron.unschedule(jobid) from cron.job where jobname = 'bedrock-purge-expired-data';
select cron.schedule('bedrock-purge-expired-data', '17 9 * * *',
                     $$select public.purge_expired_data()$$);

-- ------------------------------------------------------ storage deletes ---
-- Deleting a file is destructive, and the client role exists precisely so a
-- customer's IR contact can edit captions without being able to destroy data.
-- The table policies already say so (client_editor); storage still let any
-- member, clients included, delete every file in the org.
drop policy if exists artifacts_delete on storage.objects;
create policy artifacts_delete on storage.objects for delete
  using (bucket_id = 'artifacts'
         and public.is_org_editor(((storage.foldername(name))[1])::uuid));
