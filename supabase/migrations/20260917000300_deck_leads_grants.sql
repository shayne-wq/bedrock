-- Bedrock — deck_leads was unreadable by the people it was built for.
--
-- `20260917000100_deck_leads.sql` ended with `revoke all on public.deck_leads
-- from anon, authenticated`. The intent was right and still is: a leaked
-- publishable key must not be usable to read, stuff or scrape a customer's lead
-- list, and captures are written by the `lead` edge function on the service
-- role, never by the browser.
--
-- But PostgREST executes a SIGNED-IN console user as the `authenticated` role.
-- Revoking the table grant from that role therefore locked out the org members
-- the `leads_read` policy was written to admit. RLS said yes and the grant said
-- no, so the console's "Who is asking" panel reported "Could not read the list"
-- to the very person who owns the deck — and the CSV export had nothing to
-- export.
--
-- A grant is not a policy. Restoring the grant does not widen who can read
-- anything: `leads_read` still restricts every row to members of the org that
-- owns the deck, and `leads_delete` to its editors. This just lets those
-- policies be reached at all.

grant select, delete on public.deck_leads to authenticated;

-- Deliberately NOT granted:
--   * anything at all to `anon` — an anonymous caller must not be able to read
--     a lead list, and the gate posts captures through the `lead` function.
--   * `insert` and `update` to `authenticated` — a capture is a record of what a
--     viewer typed, and a console user editing or forging one would make the
--     list evidence of nothing. The edge function writes; people only read and,
--     if they are editors, delete.
