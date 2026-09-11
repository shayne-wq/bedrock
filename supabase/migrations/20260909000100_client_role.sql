-- A fourth role: 'client'.
--
-- The people we build a deck FOR need to sign in and edit it — the words, the
-- camera, the running order — without being able to delete the project it
-- belongs to, drop the datasets it renders, or revoke the share links it is
-- served through. 'member' grants all of that today, so inviting a customer as
-- a member hands them the demolition tools along with the pen.
--
-- This file does nothing but add the value. Postgres refuses to use a new enum
-- label in the same transaction that created it ("unsafe use of new value"),
-- and Supabase wraps each migration in one, so the policies and helpers that
-- reference 'client' live in the next migration rather than below.

alter type org_role add value if not exists 'client';
