# Standing up the backend

Bedrock is two halves. The **viewer** (`/index.html`) is a static file that needs
no backend at all — the Elk Gold demo runs entirely on its own. The **console**
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
```

Fifteen assertions, including a deliberate check that one organisation cannot
read another's analytics through the rollup functions. It exits non-zero if any
of them stops holding.

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

The suite asserts against fixtures in `supabase/seed.sql` — the Elk Gold
project, the Siwash North deck and a known share token — so it needs a local
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
`https://bedrock-fawn.vercel.app/dashboard/`) to **Redirect URLs**, or the
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
the browser and uploads only the derived artifacts — 1.18 GB of MineSight export
becomes 3.9 MB. The sensitive file never leaves the machine that exported it,
there is no GB-scale ingest bill, and the upload takes seconds.

That extractor is verified against the Python reference implementation on the
real Elk Gold model:

```bash
node tools/verify_extract.mjs /path/to/source_BM.csv
```

36 assertions — block count, tonnage, grade, ounces, straddling count, every
resource class and all 46 vein domains individually. Per-vein figures are checked
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
