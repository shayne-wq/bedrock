# Standing up the backend

Bedrock is two halves. The **viewer** (`/index.html`) is a static file that needs
no backend at all — the Bedrock Demo demo runs entirely on its own. The **console**
(`/dashboard/`) is what turns it into a platform: accounts, uploads, deck
editing, share links and audience analytics. That half needs Supabase.

All of this has been run against both a local stack (`supabase start`) and the
hosted project — schema pushed, both functions deployed, endpoints smoke-tested
live.

One difference bites when you go from local to hosted: **pgcrypto lives in the
`extensions` schema in both, but `extensions` is on the search_path locally and
not for the role that applies migrations on hosted Supabase.** An unqualified
`gen_random_bytes()` therefore applies cleanly locally and fails remotely with
`42883`. Schema-qualify it — `extensions.gen_random_bytes(...)` — in any
migration that reaches for pgcrypto. Local green does not prove remote green
here.

---

## 1. Create the project

1. Create a Supabase project. Note its **Project URL** and **anon key** from
   Project Settings → API.
2. The **service role key** from that page is used in step 3 and must never go
   anywhere near the browser. It bypasses every row-level security policy in
   this schema.

## 2. Apply the schema

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

That applies `supabase/migrations/`, which creates:

| Table | Holds |
|---|---|
| `orgs`, `org_members` | tenancy and who belongs to it |
| `projects` | one deposit each |
| `datasets` | derived block-model artifacts + exact rollups |
| `decks`, `chapters` | the walkthrough |
| `share_links` | what you send, and what an embed points at |
| `view_sessions`, `view_events` | audience analytics |

It also creates the private `artifacts` storage bucket and four rollup functions
the console's Audience panel reads.

**Verify it before trusting it:**

```bash
docker exec -i supabase_db_orebody psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -f - < supabase/tests/rls_test.sql
docker exec -i supabase_db_orebody psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -f - < supabase/tests/client_role_test.sql
```

Fifteen assertions in the first, including a deliberate check that one
organisation cannot read another's analytics through the rollup functions. The
second covers the client role and invitations. Both exit non-zero if any
assertion stops holding.

## Roles, and how somebody gets an account

Four roles: `owner`, `admin`, `member`, `client`.

The first three are interchangeable for data purposes — all three are
`is_org_editor` and may delete a project, its datasets and its share links.
`admin` and `owner` additionally manage people.

**`client` is the customer we built the deck for.** They may read their org's
projects, decks and share links, and they may write **chapters** — the caption,
the title, the camera, the running order, and deleting a slide. They may not
delete a project or a dataset, rename a project, or create and revoke share
links. This is enforced by policy, not by which buttons the console draws:
`is_org_member` for reads, `is_org_editor` for the writes that destroy things,
and `chapter_all` deliberately left at member because editing chapters is the
entire point of the account.

A client reads `share_links` because that is where the embed snippet comes
from. Issuing and revoking tokens stays with us — the token is what decides who
can see the deck at all.

### Invitations

`org_members` needs a `user_id`, which does not exist until somebody has signed
in at least once, so there is no way to grant access ahead of time by writing to
it. An invitation is therefore a row in `invites` keyed by **email**:

1. An admin invites an address from **People** in the console.
2. That person signs in at the console with the same address. Magic link, so
   signing in confirms the address.
3. The console calls `redeem_invites()` once per page load, before it lists
   anything. Every live invitation matching their **confirmed** address becomes
   an `org_members` row.

`redeem_invites()` is SECURITY DEFINER — the caller is by definition not yet a
member and cannot write `org_members` through RLS. Two things make that safe:
the address comes from `auth.users` keyed on `auth.uid()` and never from an
argument, so nobody can claim an invitation by naming it; and an **unconfirmed**
address redeems nothing, so signing up as somebody else's address collects
nothing of theirs. Matching is case-insensitive, or half the invitations sent
would silently never land.

`org_people(org)` exists because `org_members` stores no address and
`auth.users` is not readable through RLS. It is DEFINER and therefore carries
its own `is_org_admin` check in the WHERE clause — a client calling it gets
nothing.

### Sending the invitation

The `invite` edge function emails it through Postmark. It runs on the **caller's
JWT**, not the service role, so it reads `invites` through RLS and can only mail
a row whose org the caller administers — a service-role version would be an open
relay wearing our sender reputation.

Two secrets, and it returns a 501 naming the missing one rather than failing
vaguely:

```bash
supabase secrets set POSTMARK_TOKEN=<server API token> \
                     POSTMARK_FROM=<a verified sender signature> \
                     CONSOLE_URL=https://getbedrock.ca/dashboard/
supabase functions deploy invite      # note: verify_jwt stays ON for this one
```

Sending is never fatal to inviting. If Postmark is unconfigured or down the
invitation still stands and the People page still offers the link to forward by
hand, which is what it did before this existed.

**Magic links are a separate sender.** Sign-in email comes from Supabase Auth,
not from this function, and with no custom SMTP it is capped at **2 emails per
hour** for the whole project — enough to lock a client out on their first day.
Point Auth at Postmark too: Authentication → Emails → SMTP, host
`smtp.postmarkapp.com`, port 587, username and password both the server token,
sender the same verified signature.

## 3. Deploy the edge functions

```bash
supabase functions deploy deck --no-verify-jwt
supabase functions deploy track --no-verify-jwt
```

`--no-verify-jwt` is required and is not a weakening: both endpoints are called
by anonymous viewers who hold a share token and no account. Authorisation is the
token, checked inside the function.

```bash
supabase db reset                         # loads supabase/seed.sql
bash supabase/tests/functions_test.sh     # 43 assertions against a running stack
```

The suite asserts against fixtures in `supabase/seed.sql` — the Bedrock Demo
project, the North Zone deck and a known share token — so it needs a local
stack that has been reset with that seed loaded. Run it against a **local**
stack only: the seed creates a live, passcode-free share link with a guessable
token, which has no business in a hosted project.

## 4. Point the console at it

Open `/dashboard/`, paste the Project URL and anon key. They are stored in
`localStorage`, which is enough to get going.

To bake them into a deployment, fill in `BAKED` at the top of
`dashboard/config.js`. The anon key belongs in a browser — every table denies it
by default, and the console works only because an authenticated user's JWT
carries their membership.

## 5. Allow the redirect

In Authentication → URL Configuration, add your deployed console URL (e.g.
`https://getbedrock.ca/dashboard/`) to **Redirect URLs**, or the
sign-in email will bounce users to the wrong place.

---

## How a deck reaches a viewer

1. The console creates a **share link**. Its token is 24 random bytes.
2. The share URL carries the token *and* the address of your edge functions,
   because the viewer is a static file with no idea which Supabase project it
   belongs to. Miss that and the deck renders perfectly and reports nothing.
3. `deck` validates the token — not revoked, not expired, passcode correct — and
   returns the deck, its chapters, and short-lived signed URLs for the
   artifacts. The bucket stays private.
4. `track` receives engagement beacons.

Every failure mode of a token returns the same message and status. Distinguishing
"no such token" from "revoked" turns the endpoint into an oracle for guessing
them.

## What the analytics collect

No cookies. No cross-site identifier. No IP address — a country is derived at
the edge and the address discarded. The embedding page's URL is stored as host
and path with the **query string dropped**, because that is where tracking
parameters and the occasional email address live.

The session id lives in `sessionStorage`, so it is per browser tab. Closing the
tab ends it, and nothing links two visits by the same person together.

Be straight with customers about two limits:

- **These are engagement figures, not audited ones.** The endpoint is
  unauthenticated by necessity, so anyone holding a share link could inflate that
  deck's numbers. Signing the beacons would require a secret in client code,
  which is not a secret.
- **Domain restrictions on a share link are a deterrent, not a guarantee.** A
  browser only reveals the embedding page through a value that page controls, and
  the request an iframe makes carries its own origin rather than its parent's.
  Real enforcement would need a per-deck `frame-ancestors` header, which a static
  host cannot vary per token. Expiry, passcode and revocation are the controls
  that actually hold.

## Where the customer's data goes

The raw block model is **not uploaded**. `dashboard/lib/extract.js` streams it in
the browser and uploads only the derived artifacts — a multi-gigabyte MineSight export
becomes 3.9 MB. The sensitive file never leaves the machine that exported it,
there is no GB-scale ingest bill, and the upload takes seconds.

That extractor is verified against the Python reference implementation on the
real Bedrock Demo model:

```bash
node tools/verify_extract.mjs /path/to/source_BM.csv
```

36 assertions — block count, tonnage, grade, ounces, straddling count, every
resource class and all 22 vein domains individually. Per-vein figures are checked
one by one rather than trusting the total, because a total that reconciles while
its parts are wrong is exactly the share-weighting bug this guards against.

## Local development

OrbStack will not start its daemon from the app icon when an update is
pending — the socket never appears and `supabase start` fails with "Cannot
connect to the Docker daemon". `orbctl start` works regardless, and is the
reliable way in.

```bash
orbctl start          # not `open -a OrbStack`
supabase start
supabase functions serve --no-verify-jwt
```

`supabase/config.toml` puts this stack on ports `544xx` rather than the defaults
so it can run alongside another local Supabase project.

Serve the repo with **no-store** headers while developing. The viewer registers a
service worker at the site root, and although it now bypasses `/dashboard/`, any
worker already installed from an earlier build will keep serving stale console
JavaScript until it is unregistered.
